import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "../core/agent-session.js";
import {
	type AgentAutonomousConfig,
	type AgentAutonomousStatus,
	type AutonomousRuntimeState,
	addAutonomousContinuation,
	addAutonomousUsage,
	autonomousStatus,
	createAutonomousRuntimeState,
	nextAutonomousContinuation,
	refreshAutonomousQualityGates,
	setAutonomousEnabled,
} from "../core/autonomous.js";
import type { CustomMessage } from "../core/messages.js";
import type { SessionManager } from "../core/session-manager.js";
import { parseSessionSlashCommand } from "../core/slash-commands.js";
import type { SessionCompaction } from "./compaction.js";
import type { SessionContinuation } from "./continuation.js";
import type { SessionInputAdmission } from "./input-admission.js";
import { createPreparedTurnAction, primaryDeliveryRecord, type QueuedSessionAction } from "./prepared-actions.js";

type AutonomousSlashCommand = { kind: "status" } | { kind: "on" } | { kind: "off" };
type AutonomousRuntimeSnapshot = Pick<
	AutonomousRuntimeState,
	"continuationsUsed" | "gateAttempts" | "lastGateFailure" | "lastGateFailureSnapshot"
>;

export interface SessionAutonomousContinuationHost {
	getStatus(): AgentAutonomousStatus;
	getCwd(): string;
	getAgent(): Pick<Agent, "state" | "signal" | "removeQueuedMessages" | "hasQueuedMessages">;
	getStore(): Pick<SessionManager, "appendCustomMessageEntry">;
	emit(event: AgentSessionEvent): void;
	getContinuation(): Pick<SessionContinuation, "messages" | "track" | "remove">;
	getArrivalEpoch(): number;
	admit: SessionInputAdmission["admitSessionInput"];
	cancelActions(predicate: (action: QueuedSessionAction) => boolean, error: Error): QueuedSessionAction[];
	emitQueueUpdate(): void;
	getCompaction(): Pick<SessionCompaction, "resetContinuation">;
	getUnfinishedActionCount(): number;
	cancelContinuation(): void;
}
export class SessionAutonomousContinuation {
	private readonly state: AutonomousRuntimeState;
	private suppressionDepth = 0;
	private readonly suppressedMessages = new WeakSet<AgentMessage>();
	private readonly thresholdContinuations = new WeakMap<AssistantMessage, AgentMessage>();
	private readonly snapshots = new WeakMap<AgentMessage, AutonomousRuntimeSnapshot>();
	private pendingThresholdMessages: AgentMessage[] = [];
	constructor(
		config: AgentAutonomousConfig | undefined,
		private readonly host: SessionAutonomousContinuationHost,
	) {
		this.state = createAutonomousRuntimeState(config, { cwd: host.getCwd() });
	}
	forgetSnapshot(message: AgentMessage): void {
		this.snapshots.delete(message);
	}

	takePendingThresholdMessages(): AgentMessage[] {
		return this.pendingThresholdMessages.splice(0);
	}

	recordUsage(usage: Usage): void {
		addAutonomousUsage(this.state, usage);
	}
	isSuppressed(messages: AgentMessage[]): boolean {
		return this.suppressionDepth > 0 || messages.some((message) => this.suppressedMessages.has(message));
	}
	next(message: AssistantMessage, signal?: AbortSignal): Promise<AgentMessage | undefined> {
		return nextAutonomousContinuation(this.state, message, { cwd: this.host.getCwd(), signal });
	}

	parseAutonomousSlashCommand(text: string): AutonomousSlashCommand | undefined {
		const command = parseSessionSlashCommand(text);
		if (command?.name !== "autonomous") return undefined;
		const rest = command.args.toLowerCase();
		if (!rest || rest === "status") {
			return { kind: "status" };
		}
		if (rest === "on" || rest === "enable" || rest === "enabled") {
			return { kind: "on" };
		}
		if (rest === "off" || rest === "disable" || rest === "disabled") {
			return { kind: "off" };
		}
		throw new Error("Usage: /autonomous [on|off|status]");
	}

	formatAutonomousStatus(): string {
		const status = this.host.getStatus();
		const state = status.enabled ? "on" : "off";
		return `Autonomous mode: ${state}. Continuations: ${status.continuationsUsed}/${status.limits.maxContinuations}. Turns: ${status.turnsUsed}/${status.limits.maxTurns}. Tokens: ${status.tokensUsed}/${status.limits.maxTokens}.`;
	}

	emitAutonomousStatus(): void {
		const message = {
			role: "custom" as const,
			customType: "autonomous_status",
			content: this.formatAutonomousStatus(),
			display: true,
			details: this.host.getStatus(),
			timestamp: Date.now(),
		} satisfies CustomMessage<AgentAutonomousStatus>;
		this.host.getAgent().state.messages.push(message);
		this.host
			.getStore()
			.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
		this.host.emit({ type: "message_start", message });
		this.host.emit({ type: "message_end", message });
	}

	async handleAutonomousSlashCommand(text: string): Promise<boolean> {
		const command = this.parseAutonomousSlashCommand(text);
		if (!command) {
			return false;
		}
		if (command.kind === "on") {
			setAutonomousEnabled(this.state, true, { cwd: this.host.getCwd() });
		} else if (command.kind === "off") {
			setAutonomousEnabled(this.state, false);
			this.clearQueuedAutonomousContinuations();
		}
		this.emitAutonomousStatus();
		return true;
	}

	snapshotAutonomousRuntimeState(): AutonomousRuntimeSnapshot {
		return {
			continuationsUsed: this.state.continuationsUsed,
			gateAttempts: { ...this.state.gateAttempts },
			lastGateFailure: this.state.lastGateFailure ? { ...this.state.lastGateFailure } : undefined,
			lastGateFailureSnapshot: this.state.lastGateFailureSnapshot
				? { ...this.state.lastGateFailureSnapshot }
				: undefined,
		};
	}

	restoreAutonomousRuntimeSnapshot(snapshot: AutonomousRuntimeSnapshot): void {
		this.state.continuationsUsed = snapshot.continuationsUsed;
		this.state.gateAttempts = { ...snapshot.gateAttempts };
		this.state.lastGateFailure = snapshot.lastGateFailure ? { ...snapshot.lastGateFailure } : undefined;
		this.state.lastGateFailureSnapshot = snapshot.lastGateFailureSnapshot
			? { ...snapshot.lastGateFailureSnapshot }
			: undefined;
	}

	async queueAutonomousContinuationForThresholdCompaction(
		message: AssistantMessage,
	): Promise<AgentMessage | undefined> {
		const queuedMessage = this.thresholdContinuations.get(message);
		if (queuedMessage && this.host.getContinuation().messages.includes(queuedMessage)) {
			return queuedMessage;
		}
		const snapshot = this.snapshotAutonomousRuntimeState();
		const arrivalEpoch = this.host.getArrivalEpoch();
		const autonomousMessage = await nextAutonomousContinuation(this.state, message, {
			cwd: this.host.getCwd(),
			signal: this.host.getAgent().signal,
		});
		if (!autonomousMessage) {
			return undefined;
		}
		if (this.host.getArrivalEpoch() !== arrivalEpoch) {
			this.restoreAutonomousRuntimeSnapshot(snapshot);
			return undefined;
		}
		this.thresholdContinuations.set(message, autonomousMessage);
		this.snapshots.set(autonomousMessage, snapshot);
		this.host.getContinuation().track(autonomousMessage);
		this.pendingThresholdMessages.push(autonomousMessage);
		const text =
			typeof autonomousMessage.content === "string"
				? autonomousMessage.content
				: autonomousMessage.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
		this.host.admit(
			createPreparedTurnAction("followUp", text, undefined, {
				message: autonomousMessage,
			}),
		);
		return autonomousMessage;
	}

	clearQueuedAutonomousContinuations(
		options: { restoreAutonomousState?: boolean; messages?: AgentMessage[] } = {},
	): void {
		const requestedMessages = options.messages ?? [...this.host.getContinuation().messages];
		const requestedMessageSet = new Set(requestedMessages);
		const queuedMessages = this.host.getContinuation().messages.filter((message) => requestedMessageSet.has(message));
		if (queuedMessages.length === 0) {
			return;
		}
		const queuedMessageSet = new Set(queuedMessages);
		this.host.getContinuation().remove(queuedMessageSet);
		this.host.getAgent().removeQueuedMessages((message) => queuedMessageSet.has(message));
		this.host.cancelActions(
			(action) => action.payload.kind === "turn" && queuedMessageSet.has(primaryDeliveryRecord(action).message),
			new Error("Queued autonomous continuation was cleared before delivery."),
		);
		this.host.emitQueueUpdate();
		if (options.restoreAutonomousState) {
			for (const queuedMessage of queuedMessages) {
				const snapshot = this.snapshots.get(queuedMessage);
				if (snapshot) {
					this.restoreAutonomousRuntimeSnapshot(snapshot);
					break;
				}
			}
		}
		for (const queuedMessage of queuedMessages) {
			this.snapshots.delete(queuedMessage);
		}
		this.pendingThresholdMessages = this.pendingThresholdMessages.filter((message) => !queuedMessageSet.has(message));
		if (options.messages === undefined) {
			this.host.getCompaction().resetContinuation();
		}
		if (!this.host.getAgent().hasQueuedMessages() && this.host.getUnfinishedActionCount() === 0) {
			this.host.cancelContinuation();
		}
	}

	clearQueuedAutonomousContinuationsAfterSkippedThresholdCompaction(
		shouldContinueAfterThreshold: boolean,
		queuedMessages: AgentMessage[],
	): void {
		if (shouldContinueAfterThreshold) {
			this.clearQueuedAutonomousContinuations({
				restoreAutonomousState: true,
				messages: queuedMessages,
			});
		}
	}

	getAutonomousStatus(): AgentAutonomousStatus {
		return autonomousStatus(this.state);
	}

	recordHostAutonomousContinuation(): void {
		addAutonomousContinuation(this.state);
	}

	async refreshAutonomousGates(): Promise<void> {
		await refreshAutonomousQualityGates(this.state, {
			cwd: this.host.getCwd(),
		});
	}

	async runWithAutonomousContinuationSuppressed<T>(fn: () => Promise<T>): Promise<T> {
		this.suppressionDepth++;
		try {
			return await fn();
		} finally {
			this.suppressionDepth--;
		}
	}

	markAutonomousContinuationSuppressed(message: AgentMessage): void {
		this.suppressedMessages.add(message);
	}
}
