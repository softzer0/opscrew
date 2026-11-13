import type { ProviderBackupsApi } from "@opscrew/contracts";

/**
 * A provider's automated backups as its connector turns them on (Contabo's Auto Backup): every
 * call is recorded in `calls` (`turnOn <server id>`) and told to `onCall`; `refused` answers a
 * refusal and `error` makes the call fail without a clear answer.
 */
export class FakeProviderBackups implements ProviderBackupsApi {
  readonly calls: string[] = [];
  refused: string | undefined;
  error: Error | undefined;

  constructor(
    /** Hears of each call, e.g. to keep it in order with a test's other events. */
    readonly onCall: (entry: string) => void = () => undefined,
  ) {}

  async turnOn(serverId: string): Promise<{ refused: string } | undefined> {
    const entry = `turnOn ${serverId}`;
    this.calls.push(entry);
    this.onCall(entry);
    if (this.error !== undefined) throw this.error;
    return this.refused === undefined ? undefined : { refused: this.refused };
  }
}
