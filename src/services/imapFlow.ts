/**
 * ImapFlow with a lost-wakeup fix in its response reader.
 *
 * ImapFlow drains parsed responses in an async loop guarded by a `reading`
 * flag, and ignores 'readable' events while the flag is set. A response that
 * becomes readable after the loop's final read() returns null, but before the
 * loop's finally clears the flag, is never processed and the pending command
 * hangs. Node's event ordering rarely opens that window; the Workers runtime
 * opens it on the first CAPABILITY after login. Here a 'readable' that arrives
 * mid-drain schedules one more drain instead of being dropped.
 */
import { ImapFlow as BaseImapFlow } from "imapflow";

interface ReaderInternals {
  reading: boolean;
  reader(): Promise<void>;
  socketReadable: () => void;
  streamer: { on(event: "readable", listener: () => void): void };
  log: { error(entry: Record<string, unknown>): void };
  id: string;
}

export class ImapFlow extends BaseImapFlow {
  /** Overrides ImapFlow's internal hook; see the module comment. */
  setEventHandlers(): void {
    const self = this as unknown as ReaderInternals;
    let again = false;
    const drain = () => {
      self.reading = true;
      self
        .reader()
        .catch((err) => self.log.error({ err, cid: self.id }))
        .finally(() => {
          if (again) {
            again = false;
            drain();
          } else {
            self.reading = false;
          }
        });
    };
    self.socketReadable = () => {
      if (self.reading) again = true;
      else drain();
    };
    self.streamer.on("readable", self.socketReadable);
  }
}
