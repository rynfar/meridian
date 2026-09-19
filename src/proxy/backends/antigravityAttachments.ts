import { preprocessAgMedia } from "./antigravityMedia"
import { fetchAgImage } from "./antigravityUrl"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { readdir, stat, chmod } from "node:fs/promises"
const exec = promisify(execFile)
import { createHash } from "node:crypto"
import { writeFile, rename } from "node:fs/promises"
import { join } from "node:path"
import { AntigravityError, blocks, type AgBlock, type AgMessage, type AgResult } from "./antigravityProtocol"

/** Materialize supplied bytes and validated public images, never caller filesystem paths. */
export class AgAttachments {
  private readonly paths = new Set<string>()
  private bytes = 0
  private fetches = 0
  constructor(private readonly workspace: string, private readonly signal?: AbortSignal) {}
  private reserve(bytes: number): void {
    this.bytes += bytes
    if (this.bytes > 32 * 1024 * 1024 || this.paths.size >= 64) throw new AntigravityError("Conversation attachments exceed 32 MiB or 64 rendered images", 413)
    if (this.signal?.aborted) throw new AntigravityError("Attachment processing cancelled", 499)
  }
  get present(): boolean { return this.paths.size > 0 }
  async content(content: AgBlock[]): Promise<AgBlock[]> {
    const result: AgBlock[] = []
    for (const block of content) {
      if (block.type === "image") {
        if (block.source.type === "url" && ++this.fetches > 64) throw new AntigravityError("Conversation exceeds 64 remote image fetches", 413)
        const { data, media_type: mime } = block.source.type === "url" ? await fetchAgImage(block.source.url, this.signal) : block.source
        const bytes = Buffer.from(data, "base64")
        const valid = mime === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          : mime === "image/jpeg" ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
          : mime === "image/gif" ? /GIF8[79]a/.test(bytes.subarray(0, 6).toString("ascii"))
          : bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP"
        if (!valid || bytes.toString("base64") !== data) throw new AntigravityError("Image data does not match its declared media_type or canonical base64 encoding")
        const name = createHash("sha256").update(bytes).digest("hex")
        const path = join(this.workspace, `attachment-${name}.${mime.split("/")[1]}`)
        if (!this.paths.has(path)) {
          this.reserve(bytes.length)
          await writeFile(path, bytes, { flag: "wx", mode: 0o600 })
          this.paths.add(path)
        }
        result.push({ type: "text", text: `Meridian image attachment (${mime}): use view_file to inspect exactly ${path}` })
      } else if (block.type === "audio" || block.type === "video") {
        const bytes = Buffer.from(block.source.data, "base64")
        if (bytes.toString("base64") !== block.source.data || !bytes.length) throw new AntigravityError("Media requires canonical nonempty base64")
        this.reserve(bytes.length)
        const path = join(this.workspace, `media-${createHash("sha256").update(bytes).digest("hex")}`)
        await writeFile(path, bytes, { mode: 0o600 })
        const media = await preprocessAgMedia(path, block.type, this.workspace, this.signal)
        result.push({ type: "text", text: media.text })
        for (let index = 0; index < media.frames.length; index++) {
          const frame = media.frames[index]!
          await chmod(frame, 0o600)
          this.reserve((await stat(frame)).size)
          this.paths.add(frame)
          result.push({ type: "text", text: `Video sampled frame ${index + 1}: use view_file to inspect exactly ${frame}` })
        }
      } else if (block.type === "document") {
        const bytes = block.source.type === "text" ? Buffer.from(block.source.data) : Buffer.from(block.source.data, "base64")
        if (block.source.type === "base64" && bytes.toString("base64") !== block.source.data) throw new AntigravityError("Document requires canonical base64")
        if (block.source.media_type === "text/plain") {
          this.reserve(bytes.length)
          let text: string
          try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes) }
          catch { throw new AntigravityError("Text documents require valid UTF-8") }
          result.push({ type: "text", text: `Document ${block.title ?? "attachment"}:\n${text}` })
        } else {
          if (bytes.subarray(0, 5).toString() !== "%PDF-") throw new AntigravityError("Document bytes are not a PDF")
          const digest = createHash("sha256").update(bytes).digest("hex")
          const input = join(this.workspace, `document-${digest}.pdf`)
          const prefix = join(this.workspace, `page-${digest}`)
          this.reserve(bytes.length)
          await writeFile(input, bytes, { mode: 0o600 })
          try {
            const info = await exec("pdfinfo", [input], { timeout: 15000, maxBuffer: 65536, signal: this.signal })
            const pages = Number(/^Pages:\s+(\d+)/m.exec(info.stdout)?.[1])
            if (!pages || pages > 16) throw new AntigravityError("PDFs must contain between 1 and 16 pages")
            await exec("pdftoppm", ["-f", "1", "-l", String(pages), "-scale-to", "1600", "-png", input, prefix], { timeout: 30000, maxBuffer: 65536, signal: this.signal })
            const files = (await readdir(this.workspace)).filter(file => file.startsWith(`page-${digest}-`) && file.endsWith(".png")).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
            if (files.length !== pages) throw new AntigravityError("PDF renderer omitted pages")
            result.push({ type: "text", text: `Document ${block.title ?? "attachment"}: ${pages} rendered pages. Page references below are local preprocessing, not native document citations.` })
            for (let page = 0; page < files.length; page++) {
              const path = join(this.workspace, files[page]!)
              await chmod(path, 0o600)
              const size = (await stat(path)).size
              this.reserve(size)
              if (size > 8 * 1024 * 1024) throw new AntigravityError("Rendered PDF page exceeded 8 MiB")
              this.paths.add(path)
              result.push({ type: "text", text: `Document page ${page + 1}: use view_file to inspect exactly ${path}` })
            }
          } catch (error) {
            if (error instanceof AntigravityError) throw error
            throw new AntigravityError("PDF preprocessing requires working local Poppler pdfinfo/pdftoppm: " + String(error))
          }
        }
      } else if (block.type === "tool_result") result.push(await this.toolResult(block))
      else result.push(block)
    }
    // Hooks may run while an HTTP continuation adds images. Atomic replacement
    // prevents an in-flight hook from observing a partially written allowlist.
    const list = join(this.workspace, "attachment-paths.json")
    await writeFile(list + ".tmp", JSON.stringify([...this.paths]), { mode: 0o600 })
    await rename(list + ".tmp", list)
    return result
  }
  async toolResult(result: AgResult): Promise<AgResult> {
    if (!Array.isArray(result.content)) return result
    const content = await this.content(result.content)
    return { ...result, content: content.filter(b => b.type === "text" || b.type === "image") }
  }
  async messages(messages: AgMessage[]): Promise<AgMessage[]> {
    const result: AgMessage[] = []
    for (const message of messages) result.push({ ...message, content: await this.content(blocks(message)) })
    return result
  }
}
