/** Node preload for an app-owned CLI process; the CLI itself is the entrypoint.
 * Do not import/call runCli here: published bundles already start on evaluation.
 */
process.once('disconnect', () => {
  // The CLI owns graceful SIGTERM after initialization. Before then the signal
  // terminates startup normally, rather than leaving an orphan listener.
  process.kill(process.pid, 'SIGTERM')
})
if (!process.connected) throw new Error('Managed Meridian requires its desktop IPC parent.')
// This acknowledges only the watchdog. The parent independently verifies the
// actual HTTP version and (on macOS) the listening process before claiming ready.
process.send?.({ ready: true })
