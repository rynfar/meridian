/** Event barriers for HTTP/SDK test doubles; deadlines fail, never imply completion. */
export function settlementBarrier() {
  let resolve: () => void = () => { throw new Error("barrier not initialized") }
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

export async function withTestDeadline<T>(promise: PromiseLike<T> | T, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle within 2 seconds`)), 2_000)
  })
  try {
    return await Promise.race([Promise.resolve(promise), deadline])
  } finally {
    clearTimeout(timer)
  }
}
