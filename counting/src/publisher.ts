/**
 * Gets arrival events off the counting unit and into Supabase.
 *
 * Same shape as the tablet's sync engine, for the same reason: the link at the
 * yard is unreliable, so events are durable locally first and drain when they
 * can. The differences from the tablet are deliberate —
 *
 *   - it posts to an edge function with a shared secret rather than talking to
 *     Postgres, so an on-site box never holds a Supabase key;
 *   - the buffer is bounded. A POS queue must never drop a sale; a counting
 *     feed that has been offline for days is better off keeping its most
 *     recent events than its oldest. What is dropped is counted and reported,
 *     so a truncated buffer shows up as a data-quality flag rather than as a
 *     quiet undercount.
 */

import type { VehicleArrivalEvent } from "./source.ts";

export interface PublisherOptions {
  ingestUrl: string;
  ingestSecret: string;
  branchId: string;
  /** Events per request. */
  batchSize?: number;
  /** Hard ceiling on the local buffer. */
  maxBuffered?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export interface FlushResult {
  published: number;
  buffered: number;
  dropped: number;
  error?: string;
}

export class EventPublisher {
  private readonly options: Required<Omit<PublisherOptions, "fetchImpl">>;
  private readonly fetchImpl: typeof fetch;
  private buffer: VehicleArrivalEvent[] = [];
  private droppedTotal = 0;

  constructor(options: PublisherOptions) {
    this.options = {
      ingestUrl: options.ingestUrl,
      ingestSecret: options.ingestSecret,
      branchId: options.branchId,
      batchSize: options.batchSize ?? 100,
      maxBuffered: options.maxBuffered ?? 10_000
    };
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get pending(): number {
    return this.buffer.length;
  }

  get dropped(): number {
    return this.droppedTotal;
  }

  enqueue(events: VehicleArrivalEvent[]): void {
    this.buffer.push(...events);

    if (this.buffer.length > this.options.maxBuffered) {
      const overflow = this.buffer.length - this.options.maxBuffered;
      this.buffer.splice(0, overflow);
      this.droppedTotal += overflow;
    }
  }

  /**
   * Push one batch. Events stay buffered on any failure — the ingest endpoint
   * is idempotent on (branch_id, idempotency_key), so re-sending a batch whose
   * response was lost is safe and lands once.
   */
  async flush(): Promise<FlushResult> {
    if (this.buffer.length === 0) {
      return { published: 0, buffered: 0, dropped: this.droppedTotal };
    }

    const batch = this.buffer.slice(0, this.options.batchSize);

    try {
      const response = await this.fetchImpl(this.options.ingestUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Counting-Secret": this.options.ingestSecret
        },
        body: JSON.stringify({ branch_id: this.options.branchId, events: batch })
      });

      if (!response.ok) {
        return {
          published: 0,
          buffered: this.buffer.length,
          dropped: this.droppedTotal,
          error: `ingest responded ${response.status}`
        };
      }

      this.buffer = this.buffer.slice(batch.length);
      return {
        published: batch.length,
        buffered: this.buffer.length,
        dropped: this.droppedTotal
      };
    } catch (error) {
      return {
        published: 0,
        buffered: this.buffer.length,
        dropped: this.droppedTotal,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /** Drain everything currently buffered, a batch at a time. */
  async flushAll(): Promise<FlushResult> {
    let published = 0;
    let lastError: string | undefined;

    while (this.buffer.length > 0) {
      const result = await this.flush();
      published += result.published;
      if (result.error) {
        lastError = result.error;
        break;
      }
    }

    return {
      published,
      buffered: this.buffer.length,
      dropped: this.droppedTotal,
      ...(lastError ? { error: lastError } : {})
    };
  }
}
