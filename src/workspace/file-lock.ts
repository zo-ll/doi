// One write at a time for each file. A full rewrite (read, change, replace) must not lose a
// write that starts while it runs.
const queues = new Map<string, Promise<unknown>>();

export function withFileLock<T>(path: string, job: () => Promise<T>): Promise<T> {
  const run = (queues.get(path) ?? Promise.resolve()).then(job, job);
  const tail = run.catch(() => {});
  queues.set(path, tail);
  void tail.then(() => {
    if (queues.get(path) === tail) queues.delete(path);
  });
  return run;
}
