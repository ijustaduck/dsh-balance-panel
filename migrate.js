/**
 * One-shot history restoration.
 *
 * The session files themselves are copied by the installer. This module
 * re-attaches the copied Sessions to their original Workspaces through the
 * live registry, because the current build only bootstraps history while its
 * Workspace registry is still uninitialized. It runs only while
 * `$DSH_HOME/storages/dsh-balance-panel/import.json` exists, then renames that
 * manifest so a restart cannot repeat the work.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export function stateDir() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'storages', 'dsh-balance-panel')
}

export async function maybeImportHistory(ctx, controller) {
  const manifest = join(stateDir(), 'import.json')
  if (!existsSync(manifest)) return
  const log = (level, text) => controller?.log?.(level, text)

  let plan
  try {
    plan = JSON.parse(readFileSync(manifest, 'utf8'))
  } catch (error) {
    log('warn', `history import manifest is unreadable: ${describe(error)}`)
    return
  }

  const registry = service(ctx, 'workspaceRegistry')
  if (!registry || typeof registry.create !== 'function') {
    log('warn', 'workspaceRegistry is unavailable; history import stays pending')
    return
  }

  const result = { at: new Date().toISOString(), workspaces: [] }
  for (const entry of Array.isArray(plan?.workspaces) ? plan.workspaces : []) {
    if (!entry || typeof entry.path !== 'string') continue
    const item = {
      path: entry.path,
      title: entry.title ?? null,
      workspaceId: null,
      attached: [],
      alreadyAttached: [],
      failed: [],
    }
    try {
      const workspace = await registry.create(entry.path, entry.title)
      item.workspaceId = String(workspace.id)
      const ids = Array.isArray(entry.sessionIds) ? entry.sessionIds.filter((id) => typeof id === 'string') : []
      // The stored array is newest-first; attachSession prepends, so replay it
      // oldest-first to keep the original order.
      for (const id of [...ids].reverse()) {
        try {
          if (workspace.sessionIds.includes(id)) {
            item.alreadyAttached.push(id)
            continue
          }
          const holder = registry.list().find((candidate) => String(candidate.id) !== String(workspace.id) && candidate.sessionIds.includes(id))
          if (holder) {
            item.failed.push({ id, error: `already accounted by workspace ${holder.id}` })
            continue
          }
          await workspace.attachSession(id)
          item.attached.push(id)
        } catch (error) {
          item.failed.push({ id, error: describe(error) })
        }
      }
    } catch (error) {
      item.failed.push({ id: null, error: describe(error) })
    }
    result.workspaces.push(item)
  }

  result.attached = result.workspaces.reduce((total, item) => total + item.attached.length, 0)
  result.failed = result.workspaces.reduce((total, item) => total + item.failed.length, 0)

  try {
    mkdirSync(dirname(manifest), { recursive: true })
    writeFileSync(join(stateDir(), 'import.result.json'), JSON.stringify(result, null, 2))
    renameSync(manifest, join(stateDir(), 'import.done.json'))
    log('info', `history import: ${result.attached} Session(s) attached, ${result.failed} failure(s)`)
  } catch (error) {
    log('warn', `history import finished but its bookkeeping failed: ${describe(error)}`)
  }
}

function service(ctx, name) {
  try {
    return ctx.get?.(name)
  } catch {
    return undefined
  }
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}
