import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { describe, expect, it } from "vitest";
import { tarStream } from "./tar";
import { parseTar } from "./testing/tar";

/** `data` as a stream of `piece`-byte chunks. */
function chunked(data: Buffer, piece = 1000): Readable {
  return Readable.from(
    (function* () {
      for (let at = 0; at < data.length; at += piece) yield data.subarray(at, at + piece);
    })(),
  );
}

describe("tarStream", () => {
  it("writes a streamed file as it arrives, beside files given whole", async () => {
    const big = randomBytes(70_001);
    const archive = await buffer(
      tarStream([
        { name: "snap/", type: "dir", mode: 0o700, uid: 1000, gid: 1000 },
        {
          name: "snap/db.dump",
          type: "file",
          mode: 0o600,
          uid: 1000,
          gid: 1000,
          stream: chunked(big),
          size: big.length,
        },
        {
          name: "snap/about.json",
          type: "file",
          mode: 0o600,
          uid: 1000,
          gid: 1000,
          data: Buffer.from("{}\n"),
        },
      ]),
    );
    const entries = parseTar(archive);
    expect(entries.map((entry) => [entry.name, entry.mode, entry.uid])).toEqual([
      ["snap/", 0o700, 1000],
      ["snap/db.dump", 0o600, 1000],
      ["snap/about.json", 0o600, 1000],
    ]);
    expect(entries[1]?.data?.equals(big)).toBe(true);
    expect(entries[2]?.data?.toString()).toBe("{}\n");
    expect(archive.length % 512).toBe(0);
  });

  it("fails, never writing a short or long file whole, when the stream isn't its size", async () => {
    for (const size of [99, 101]) {
      const stream = chunked(randomBytes(100), 30);
      const archive = tarStream([
        { name: "f", type: "file", mode: 0o600, uid: 0, gid: 0, stream, size },
      ]);
      await expect(buffer(archive)).rejects.toMatchObject({ code: "ARTIFACT_INVALID" });
      expect(stream.destroyed).toBe(true);
    }
  });

  it("fails when the stream fails", async () => {
    const stream = new Readable({
      read() {
        this.destroy(new Error("the download broke off"));
      },
    });
    const archive = tarStream([
      { name: "f", type: "file", mode: 0o600, uid: 0, gid: 0, stream, size: 10 },
    ]);
    await expect(buffer(archive)).rejects.toThrow("the download broke off");
  });
});
