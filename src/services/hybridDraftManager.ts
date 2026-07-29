import { DraftManager, type CreateDraftInput, type DraftResult } from "@/services/draftManager.js";
import {
  ImapDraftManager,
  type ImapDraftResult,
  type ImapDraftUpdate,
} from "@/services/imapDraftManager.js";
import type { Draft, SendingIdentity } from "@/types.js";

export type HybridDraftResult = ImapDraftResult;

export interface HybridDraftManagerOptions {
  legacy?: DraftManager;
  imap?: ImapDraftManager;
}

/**
 * Provider-neutral draft facade. New drafts use server-side IMAP whenever the
 * selected identity has an IMAP profile; older AppleScript-indexed drafts keep
 * working through the legacy manager.
 */
export class HybridDraftManager {
  readonly legacy: DraftManager;
  readonly imap: ImapDraftManager;

  constructor(options: HybridDraftManagerOptions = {}) {
    this.legacy = options.legacy ?? new DraftManager();
    this.imap =
      options.imap ??
      new ImapDraftManager({
        resolveIdentity: (selector) => this.legacy.resolveIdentity(selector),
      });
  }

  listSendingIdentities(): SendingIdentity[] {
    return this.legacy.listSendingIdentities();
  }

  getDefaultIdentity(): SendingIdentity | null {
    return this.legacy.getDefaultIdentity();
  }

  setDefaultIdentity(selector: string): SendingIdentity | null {
    return this.legacy.setDefaultIdentity(selector);
  }

  resolveIdentity(selector?: string): SendingIdentity | null {
    return this.legacy.resolveIdentity(selector);
  }

  async listDrafts(): Promise<{ success: boolean; drafts?: Draft[]; error?: string }> {
    const [server, legacy] = await Promise.all([
      this.imap.listDrafts(),
      Promise.resolve(this.legacy.listDrafts()),
    ]);
    if (!server.success && !legacy.success) {
      return {
        success: false,
        error: [server.error, legacy.error].filter(Boolean).join(" "),
      };
    }
    const drafts = [...(server.drafts ?? []), ...(legacy.drafts ?? [])];
    return {
      success: true,
      drafts,
      error:
        !server.success || !legacy.success
          ? [server.error, legacy.error].filter(Boolean).join(" ")
          : undefined,
    };
  }

  async getDraft(draftId: string): Promise<HybridDraftResult> {
    if (this.imap.owns(draftId)) return this.imap.getDraft(draftId);
    return this.fromLegacy(this.legacy.getDraft(draftId));
  }

  async createDraft(input: CreateDraftInput & { htmlBody?: string }): Promise<HybridDraftResult> {
    if (this.imap.canCreate(input.from)) {
      return this.imap.createDraft(input);
    }
    if (input.htmlBody) {
      return {
        success: false,
        error:
          "HTML draft creation requires an IMAP profile for the selected identity; the AppleScript fallback only supports plain text.",
      };
    }
    return this.fromLegacy(this.legacy.createDraft(input));
  }

  async updateDraft(draftId: string, update: ImapDraftUpdate): Promise<HybridDraftResult> {
    if (this.imap.owns(draftId)) return this.imap.updateDraft(draftId, update);
    if (
      update.htmlBody !== undefined ||
      update.attachmentsToAdd?.length ||
      update.attachmentNamesToRemove?.length
    ) {
      return {
        success: false,
        error:
          "This older AppleScript draft cannot safely edit HTML or attachments. Create a new IMAP-backed draft to use full editing.",
      };
    }
    return this.fromLegacy(
      this.legacy.updateDraft(draftId, {
        expectedRevision: update.expectedRevision,
        from: update.from,
        to: update.to,
        cc: update.cc,
        bcc: update.bcc,
        subject: update.subject,
        body: update.body,
      })
    );
  }

  async sendDraft(draftId: string, expectedRevision?: string): Promise<HybridDraftResult> {
    if (this.imap.owns(draftId)) return this.imap.sendDraft(draftId, expectedRevision);
    return this.fromLegacy(this.legacy.sendDraft(draftId, expectedRevision));
  }

  async deleteDraft(draftId: string): Promise<HybridDraftResult> {
    if (this.imap.owns(draftId)) return this.imap.deleteDraft(draftId);
    return this.fromLegacy(this.legacy.deleteDraft(draftId));
  }

  async resolveUncertainSend(
    draftId: string,
    outcome: "sent" | "not_sent"
  ): Promise<HybridDraftResult> {
    if (!this.imap.owns(draftId)) {
      return {
        success: false,
        error: "Only IMAP-backed drafts have connector-managed uncertain SMTP state.",
      };
    }
    return this.imap.resolveUncertainSend(draftId, outcome);
  }

  private fromLegacy(result: DraftResult): HybridDraftResult {
    return result;
  }
}
