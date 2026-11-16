/** Keep native SQL continuations synchronous; JSON continuations follow durable I/O. */
export function mapStoreMutation<T, U>(value: T | Promise<T>, continuation: (value: T) => U): U | Promise<U> {
  return value instanceof Promise ? value.then(continuation) : continuation(value)
}
