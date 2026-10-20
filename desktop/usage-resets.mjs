import { randomUUID } from 'node:crypto';
import { resetCreditDetails, resetCreditUnavailableReason } from './usage.mjs';

function selectedCreditMetadata(credits, creditId) {
  const raw = Array.isArray(credits) ? credits.find(credit => credit?.id === creditId) : null;
  return raw && (raw.expiresAt === null || Number.isSafeInteger(raw.expiresAt)) ? { id: creditId, title: typeof raw.title === 'string' ? raw.title.slice(0, 150) : null, expiresAt: raw.expiresAt } : null;
}

function savedResetAttempt(value) {
  if (!value) return null;
  // Older versions persisted only the key. Preserve that provider-default
  // attempt rather than changing its credit choice during a retry.
  const attempt = typeof value === 'string' ? { idempotencyKey: value, creditId: null } : value;
  if (!attempt || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(attempt.idempotencyKey)
    || (attempt.creditId != null && (typeof attempt.creditId !== 'string' || !attempt.creditId.trim()))) throw new Error('The pending usage reset could not be checked safely. Keep it pending and contact support.');
  return { idempotencyKey: attempt.idempotencyKey, creditId: attempt.creditId ?? null };
}

/** Only the desktop UI calls this. There is no agent tool or automatic route. */
export class ManualUsageReset {
  constructor({ read, consume, confirm, getAttempt = () => null, saveAttempt = async () => {}, refresh = async () => {} }) { Object.assign(this, { read, consume, confirm, getAttempt, saveAttempt, refresh }); this.busy = false; }
  async request(provider, creditId = null) {
    if (provider !== 'codex') throw new Error('This connection does not expose reset-credit redemption.');
    if (this.busy) throw new Error('A usage reset is already awaiting confirmation or completion.');
    if (creditId != null && (typeof creditId !== 'string' || !creditId.trim())) throw new Error('Choose a valid usage reset from the refreshed list.');
    this.busy = true;
    try {
      const data = await this.read();
      const count = data?.rateLimitResetCredits?.availableCount;
      const previous = savedResetAttempt(this.getAttempt());
      // The first request may have spent the last credit before its reply was
      // lost. Checking that same attempt must remain possible with zero left.
      if (!previous && (!Number.isSafeInteger(count) || count <= 0)) return { outcome: 'noCredit' };
      let selected = null;
      const summary = data?.rateLimitResetCredits, rows = summary?.credits;
      if (previous) {
        if (creditId != null && creditId !== previous.creditId) throw new Error('A previous reset is still pending. Check that reset before choosing another one.');
        creditId = previous.creditId;
      } else if (Array.isArray(rows)) {
        const normalized = resetCreditDetails(summary);
        selected = creditId == null ? normalized.find(credit => credit.usable) : normalized.find(credit => credit.id === creditId);
        if (!selected) throw new Error(creditId == null ? 'No reset in the refreshed list is available to use.' : 'The selected reset is no longer in the refreshed list. Choose an available reset again.');
        const reason = resetCreditUnavailableReason(selected);
        if (reason) throw new Error(`The selected reset cannot be used: ${reason.toLowerCase()}. Choose an available reset again.`);
        creditId = selected.id;
      } else if (creditId != null) throw new Error('The provider did not supply reset details. Refresh usage before choosing a particular reset.');
      const credit = creditId == null ? null : selectedCreditMetadata(rows, creditId);
      if (!await this.confirm({ provider, count, retry: Boolean(previous), credit })) return { outcome: 'cancelled' };
      // A chosen credit may expire while its confirmation dialog is open.
      if (selected && resetCreditUnavailableReason(selected)) throw new Error('The selected reset expired while awaiting confirmation. Refresh usage and choose another reset.');
      const attempt = previous || { idempotencyKey: randomUUID(), creditId };
      await this.saveAttempt(attempt);
      // Keep the key and exact credit on ambiguous failure. Rechecking a
      // pending attempt never switches to a new credit, even with zero left.
      const result = await this.consume(attempt.idempotencyKey, attempt.creditId);
      if (!['reset', 'nothingToReset', 'noCredit', 'alreadyRedeemed'].includes(result?.outcome)) throw new Error('The provider did not confirm the reset outcome. Refresh usage before retrying.');
      await this.saveAttempt(null);
      let usageRefreshed = false;
      try { usageRefreshed = (await this.refresh()) !== false; } catch { /* The confirmed reset still succeeded. */ }
      return { ...result, usageRefreshed };
    } finally { this.busy = false; }
  }
}
