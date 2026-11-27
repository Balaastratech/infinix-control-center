// Workflow engine entry point. Called once per applied webhook event (including pending events applied after a sync).
// Never called for differences sync finds on its own. Block 5 implements it.
export interface WorkflowEvent {
  eventId: string;
  type: string;
  orderId: string;
  occurredAt: string;
  data: Record<string, unknown>;
}

export async function onWebhookEvent(event: WorkflowEvent): Promise<void> {
  void event; // ponytail: no-op until Block 5
}
