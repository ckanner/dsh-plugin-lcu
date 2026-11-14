/** One attached LCU owner per live Agent, shared by desktop and SDK entrypoints. @module */
const managed = new WeakSet<object>()
export function isManagedAgent(agent: object): boolean { return managed.has(agent) }
export function claimManagedAgent(agent: object): () => void {
  if (managed.has(agent)) throw new Error('LCU Agent already has a managed owner')
  managed.add(agent)
  return () => { managed.delete(agent) }
}
