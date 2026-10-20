const watched = new WeakSet();

/** Pipe failures belong to the owning provider request, even after its process exits. */
export function watchProviderOutputErrors(child) {
  if (watched.has(child)) return child;
  watched.add(child);
  // Native request handlers already listen for child errors. Readable pipes
  // emit their own errors, which otherwise become uncaught host exceptions.
  // Keep these listeners after exit so late pipe errors are contained too.
  for (const stream of [child.stdout, child.stderr]) stream.on('error', error => child.emit('error', error));
  return child;
}
