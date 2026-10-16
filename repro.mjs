// Run with Bun: bun repro.mjs /absolute/opencode-checkout /absolute/output.log
// Real Permission.Service + SQLite + file logger; no model, browser, or live user data.
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"

const repo = path.resolve(process.argv[2])
const output = path.resolve(process.argv[3])
const home = await mkdtemp(path.join(os.tmpdir(), "opencode-permission-proof-"))
Object.assign(process.env, {
  HOME: home,
  OPENCODE_TEST_HOME: home,
  XDG_CONFIG_HOME: path.join(home, "config"),
  XDG_DATA_HOME: path.join(home, "data"),
  XDG_STATE_HOME: path.join(home, "state"),
  XDG_CACHE_HOME: path.join(home, "cache"),
  OPENCODE_DB: ":memory:",
})
const require = createRequire(path.join(repo, "packages/core/package.json"))
const load = (name) => import(require.resolve(name))
const permissionFile = require.resolve("@opencode/core/permission")
if (!permissionFile.startsWith(repo + path.sep)) throw new Error("Wrong checkout resolved")

try {
  const [
    { Effect, Layer, Logger },
    { NodeFileSystem },
    { AppNodeBuilder },
    { LayerNode },
    { Database },
    { Bus },
    { Location },
    { Agent },
    { Permission },
    { PermissionSaved },
    { PluginHooks },
    { Project },
    { ProjectTable },
    { SessionStore },
    { SessionTable },
    { fileLogger },
  ] = await Promise.all([
    load("effect"),
    load("@effect/platform-node"),
    load("@opencode/core/effect/app-node-builder"),
    load("@opencode/util/effect/layer-node"),
    load("@opencode/core/database/database"),
    load("@opencode/core/bus"),
    load("@opencode/core/location"),
    load("@opencode/core/agent"),
    load("@opencode/core/permission"),
    load("@opencode/core/permission/saved"),
    load("@opencode/core/plugin/hooks"),
    load("@opencode/core/project"),
    load("@opencode/core/project/sql"),
    load("@opencode/core/session/store"),
    load("@opencode/core/session/sql"),
    load("@opencode/util/observability/logging"),
  ])
  const sessionID = "ses_permission_proof"
  const results = []
  const layer = AppNodeBuilder.build(
    LayerNode.group([
      Database.node, Bus.node, SessionStore.node, PermissionSaved.node,
      Agent.node, Permission.node, PluginHooks.node,
    ]),
    [Location.node.replace(Layer.succeed(Location.Service, {
      directory: "/project",
      project: { id: Project.ID.global, directory: "/project", canonical: "/project" },
    }))],
  )
  await Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.insert(ProjectTable).values({
      id: Project.ID.global, worktree: "/project", sandboxes: [],
    }).run()
    yield* db.insert(SessionTable).values({
      id: sessionID, project_id: Project.ID.global, slug: "proof",
      directory: "/project", title: "Synthetic permission proof", version: "proof", agent: "test",
    }).run()
    const agents = yield* Agent.Service
    const permission = yield* Permission.Service
    const setRules = (rules) => agents.transform((editor) =>
      editor.update("test", (agent) => { agent.permissions = rules }),
    )
    const ask = (id, action = "read") => permission.ask({
      id, sessionID, action, resources: ["PRIVATE_RESOURCE_SENTINEL"],
      save: ["*"], metadata: { hidden: "PRIVATE_METADATA_SENTINEL" },
    }).pipe(Effect.tap((result) => Effect.sync(() => results.push({ id, effect: result.effect }))))
    yield* Effect.logInfo("boundary probe started", { fixture: "isolated synthetic Permission.Service" })
    yield* setRules([{ action: "read", resource: "*", effect: "allow" }])
    yield* ask("per_configured_allow")
    yield* setRules([])
    const once = yield* ask("per_once")
    yield* permission.reply({ requestID: once.id, reply: "once" })
    const always = yield* ask("per_always")
    yield* permission.reply({ requestID: always.id, reply: "always" })
    yield* ask("per_saved_allow")
    yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
    yield* ask("per_configured_deny")
    yield* setRules([])
    const reject = yield* ask("per_reject", "write")
    yield* permission.reply({ requestID: reject.id, reply: "reject", message: "PRIVATE_FEEDBACK_SENTINEL" })
    const hooks = yield* PluginHooks.Service
    const registration = yield* hooks.register("permission", "evaluate", (event) => Effect.sync(() => {
      event.effect = "deny"
      event.message = "PRIVATE_HOOK_SENTINEL"
    }))
    yield* ask("per_hook_deny")
    yield* registration.dispose
    yield* ask("per_shutdown", "write")
    yield* permission.close
    if ((yield* permission.list()).length) throw new Error("Pending requests leaked")
    yield* Effect.logInfo("boundary probe finished", { pending: 0 })
  }).pipe(
    Effect.provide(layer),
    Effect.annotateLogs({ role: "server" }),
    Effect.provide(Logger.layer([fileLogger(output, "proof")]).pipe(
      Layer.provide(NodeFileSystem.layer), Layer.orDie,
    )),
    Effect.scoped,
    Effect.runPromise,
  )
  const log = await readFile(output, "utf8")
  if (/PRIVATE_[A-Z_]+_SENTINEL/.test(log)) throw new Error("Private fixture data leaked into the log")
  const expected = ["allow", "ask", "ask", "allow", "deny", "ask", "deny", "ask"]
  if (results.some((result, index) => result.effect !== expected[index]) || results.length !== expected.length)
    throw new Error("Permission behavior changed")
  console.log("Boundary: real Permission.Service + SQLite + production file logger")
  console.log("Fixture only; no live model, product UI, or user session")
  console.log("Base:", execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim())
  console.log("Source SHA256:", createHash("sha256").update(await readFile(permissionFile)).digest("hex"))
  console.log("Decisions:", JSON.stringify(results))
  console.log("Permission diagnostics:", log.split("\n").filter((line) => line.includes('message="permission ')).length)
  console.log("Private payload leakage: none; pending requests after close: 0")
  console.log(log.trimEnd())
} finally {
  await rm(home, { recursive: true, force: true })
}
