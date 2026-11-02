/**
 * Host half of the dsh-notify bundle.
 *
 * The feature is Client-only: every signal it renders (session running state,
 * pending user interaction, completion-unread) is already maintained by the
 * Harness Client, so the Host adds no service, no event and no Remote endpoint.
 */
export function apply() {}
