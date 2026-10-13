/** Original-parent IPC, used only by the private detached CLI child entry. */
export function detachedChildControl() {
  if (!process.send || !process.connected) throw new Error("Detached child requires its original parent channel")
  let requested = false
  let stop: (() => void) | undefined
  const requestStop = () => {
    requested = true
    stop?.()
  }
  process.on("message", (value: unknown) => {
    if (typeof value === "object" && value !== null && "type" in value && value.type === "meridian-detached-stop") requestStop()
  })
  process.once("disconnect", requestStop)
  return {
    get requested() { return requested },
    attach(callback: () => void) { stop = callback; if (requested) callback() },
    ready() {
      if (requested) return
      process.send?.({ type: "meridian-detached-ready", version: 1 }, error => { if (error) requestStop() })
    },
  }
}
