#!/usr/bin/env node
import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import type {
  ApiV1ErrorResponse,
  ApprovalStatusResponse,
  ConnectionsResponse,
  MeResponse,
  SkillBundleFile,
  SkillBundleResponse,
  ToolCallRequest,
  ToolCallResponse,
  ToolsResponse,
} from "./api-types.js"

type Config = {
  apiBase?: string
  token?: string
}

type CliError = Error & {
  exitCode?: number
}

const DEFAULT_API_BASE = "https://app.leme.ai/api"
const AGENT_SKILL_NAME = "leme"
const OUTPUT_TRUNCATE_BYTES = 20_000
const skillInstallTargets = [
  {
    label: "Codex",
    pathSegments: [".agents", "skills", AGENT_SKILL_NAME],
  },
  {
    label: "Claude",
    pathSegments: [".claude", "skills", AGENT_SKILL_NAME],
  },
] as const
const configDir = path.join(homedir(), ".config", "leme")
const configPath = path.join(configDir, "config.json")
const generatedBlockStart = "<!-- leme-init-start -->"
const generatedBlockEnd = "<!-- leme-init-end -->"
const agentInstructionsFiles = ["AGENTS.md", "CLAUDE.md"] as const

main().catch((error: CliError) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(message)
  process.exit(error.exitCode ?? 1)
})

async function main() {
  const args = process.argv.slice(2)
  const command = args.shift()

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp()
    return
  }

  if (command === "login") {
    await login(args)
    return
  }

  if (command === "logout") {
    await saveConfig({})
    console.log("Logged out.")
    return
  }

  if (command === "whoami") {
    await printJsonOrTable(await apiFetch<MeResponse>("/v1/me"))
    return
  }

  if (command === "tools") {
    await printJsonOrTable(await apiFetch<ToolsResponse>("/v1/tools"))
    return
  }

  if (command === "connections") {
    await printJsonOrTable(
      await apiFetch<ConnectionsResponse>("/v1/connections")
    )
    return
  }

  if (command === "call") {
    await callTool(args)
    return
  }

  if (command === "approvals" && args[0] === "wait") {
    await waitForApproval(args.slice(1))
    return
  }

  if (command === "init") {
    await initSkill(args)
    return
  }

  throw usage(`Unknown command: ${command}`)
}

async function login(args: string[]) {
  const token = readFlag(args, "--token") ?? args[0]

  if (!token) {
    throw usage("Usage: leme login --token <token>")
  }

  const config = await loadConfig()
  const apiBase =
    process.env.LEME_API_BASE ?? config.apiBase ?? DEFAULT_API_BASE
  const me = await apiFetch<MeResponse>("/v1/me", { apiBase, token })

  await saveConfig({
    ...config,
    apiBase,
    token,
  })
  console.log(`Logged in to ${me.projectName ?? me.projectId}.`)
}

async function callTool(args: string[]) {
  if (args[0] === "help" || args.includes("--help") || args.includes("-h")) {
    printCallHelp()
    return
  }

  const approveWait = takeFlag(args, "--approve-wait")
  const jsonOutput = takeFlag(args, "--json")
  const inputFile = readFlag(args, "--input-file")
  const outputPath = readFlag(args, "--output")
  const sdkName = args.shift()

  if (!sdkName) {
    throw usage(
      "Usage: leme call <sdkName> [json] [--input-file file] [--approve-wait] [--output file|-]"
    )
  }

  const input = await readInput(args[0], inputFile)
  const idempotencyKey = randomUUID()
  const body: ToolCallRequest = { input, sdkName }
  const response = await apiFetch<ToolCallResponse>("/v1/tools/call", {
    body,
    idempotencyKey,
    method: "POST",
  })

  if (response.status === "requires_approval" && approveWait) {
    await pollApproval(response.approvalId)
    const approvedBody: ToolCallRequest = {
      approvalId: response.approvalId,
      input,
      sdkName,
    }
    const approved = await apiFetch<ToolCallResponse>("/v1/tools/call", {
      body: approvedBody,
      idempotencyKey,
      method: "POST",
    })
    await printJsonOrTable(approved, {
      forceJson: jsonOutput,
      outputPath,
      truncateNonTty: true,
    })
    return
  }

  await printJsonOrTable(response, {
    forceJson: jsonOutput,
    outputPath,
    truncateNonTty: true,
  })

  if (response.status === "requires_approval") {
    const error = new Error(
      `Approval required. Run: leme approvals wait ${response.approvalId}`
    ) as CliError
    error.exitCode = 5
    throw error
  }
}

async function waitForApproval(args: string[]) {
  const approvalId = args[0]

  if (!approvalId) {
    throw usage("Usage: leme approvals wait <approvalId>")
  }

  await pollApproval(approvalId)
  console.log("Approved.")
}

async function initSkill(args: string[]) {
  const writeAgentDocs = takeFlag(args, "--agents-md")
  const bundle = await apiFetch<SkillBundleResponse>("/v1/skills/leme")
  const skillBundle = validateSkillBundleResponse(bundle)
  const writtenTargets: string[] = []

  for (const installTarget of skillInstallTargets) {
    const skillDir = path.join(process.cwd(), ...installTarget.pathSegments)

    await writeSkillBundle(skillDir, skillBundle.files)
    writtenTargets.push(
      `${installTarget.label} (${path.relative(process.cwd(), skillDir)})`
    )
  }

  if (writeAgentDocs) {
    await appendAgentInstructionsBlock()
  }

  console.log(
    `Wrote Leme skill ${skillBundle.version} to ${writtenTargets.join(", ")}.`
  )
}

async function pollApproval(approvalId: string) {
  const startedAt = Date.now()
  let delayMs = 2_000

  while (Date.now() - startedAt < 15 * 60 * 1000) {
    const response = await apiFetch<ApprovalStatusResponse>(
      `/v1/approvals/${approvalId}`
    )

    if (response.status === "approved") {
      return
    }

    if (response.status === "denied" || response.status === "expired") {
      const error = new Error(`Approval ${response.status}.`) as CliError
      error.exitCode = 5
      throw error
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs))
    delayMs = Math.min(delayMs + 2_000, 10_000)
  }

  const error = new Error("Timed out waiting for approval.") as CliError
  error.exitCode = 5
  throw error
}

async function apiFetch<TResponse>(
  pathname: string,
  options: {
    apiBase?: string
    body?: unknown
    idempotencyKey?: string
    method?: string
    token?: string
  } = {}
): Promise<TResponse> {
  const config = await loadConfig()
  const token = options.token ?? process.env.LEME_API_TOKEN ?? config.token

  if (!token) {
    const error = new Error(
      "Missing token. Run: leme login --token <token>"
    ) as CliError
    error.exitCode = 3
    throw error
  }

  const apiBase =
    options.apiBase ??
    process.env.LEME_API_BASE ??
    config.apiBase ??
    DEFAULT_API_BASE
  const requestInit: RequestInit = {
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.body === undefined
        ? {}
        : { "content-type": "application/json" }),
      ...(options.idempotencyKey
        ? { "idempotency-key": options.idempotencyKey }
        : {}),
    },
    method: options.method ?? "GET",
  }

  if (options.body !== undefined) {
    requestInit.body = JSON.stringify(options.body)
  }

  const response = await fetch(
    `${apiBase.replace(/\/$/, "")}${pathname}`,
    requestInit
  )
  const text = await response.text()
  const data = text ? (JSON.parse(text) as unknown) : null

  if (!response.ok) {
    const apiError =
      data && typeof data === "object" && "error" in data
        ? (data as ApiV1ErrorResponse).error
        : null
    const error = new Error(
      apiError?.message ?? response.statusText
    ) as CliError
    error.exitCode = exitCodeFor(apiError?.code, response.status)
    throw error
  }

  return data as TResponse
}

async function readInput(arg: string | undefined, inputFile: string | null) {
  if (inputFile) {
    return JSON.parse(await fs.readFile(inputFile, "utf8"))
  }

  if (arg) {
    return JSON.parse(arg)
  }

  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = []

    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }

    const raw = Buffer.concat(chunks).toString("utf8").trim()

    return raw ? JSON.parse(raw) : {}
  }

  return {}
}

async function appendAgentInstructionsBlock() {
  const block = [
    generatedBlockStart,
    "Use the Leme CLI for connected project integrations:",
    "",
    "```bash",
    "leme tools",
    "leme call <sdkName> '<json>'",
    "```",
    generatedBlockEnd,
    "",
  ].join("\n")
  const pattern = new RegExp(
    `${escapeRegExp(generatedBlockStart)}[\\s\\S]*?${escapeRegExp(generatedBlockEnd)}\\n?`
  )

  for (const instructionsFile of agentInstructionsFiles) {
    const file = path.join(process.cwd(), instructionsFile)
    let current = ""

    try {
      current = await fs.readFile(file, "utf8")
    } catch {
      current = ""
    }

    const next = pattern.test(current)
      ? current.replace(pattern, block)
      : `${current.trimEnd()}\n\n${block}`

    await fs.writeFile(file, next, "utf8")
  }
}

async function writeSkillBundle(root: string, files: SkillBundleFile[]) {
  for (const file of files) {
    const target = resolveInside(root, file.path)

    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, file.content, "utf8")
  }
}

async function loadConfig(): Promise<Config> {
  try {
    return JSON.parse(await fs.readFile(configPath, "utf8")) as Config
  } catch {
    return {}
  }
}

async function saveConfig(config: Config) {
  await fs.mkdir(configDir, { recursive: true })
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  })
}

async function printJsonOrTable(
  value: unknown,
  options: {
    forceJson?: boolean
    outputPath?: string | null
    truncateNonTty?: boolean
  } = {}
) {
  const serialized = JSON.stringify(value, null, 2)

  if (options.outputPath) {
    await writeJsonOutput(serialized, options.outputPath)
    return
  }

  if (!process.stdout.isTTY || options.forceJson) {
    writeJsonStdout(
      serialized,
      Boolean(options.truncateNonTty) && !process.stdout.isTTY
    )
    return
  }

  if (Array.isArray((value as { tools?: unknown[] }).tools)) {
    printRows((value as { tools: Array<Record<string, unknown>> }).tools, [
      "sdkName",
      "risk",
      "requiresApproval",
      "summary",
    ])
    return
  }

  if (Array.isArray((value as { connections?: unknown[] }).connections)) {
    printRows(
      (value as { connections: Array<Record<string, unknown>> }).connections,
      ["provider", "name", "status", "connectionType", "connectedForYou"]
    )
    return
  }

  console.log(serialized)
}

async function writeJsonOutput(serialized: string, outputPath: string) {
  if (outputPath === "-") {
    console.log(serialized)
    return
  }

  const target = path.resolve(process.cwd(), outputPath)
  const content = `${serialized}\n`

  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, content, "utf8")
  console.log(
    JSON.stringify(
      {
        bytes: Buffer.byteLength(content, "utf8"),
        savedTo: target,
      },
      null,
      2
    )
  )
}

function writeJsonStdout(serialized: string, truncate: boolean) {
  const content = `${serialized}\n`
  const buffer = Buffer.from(content, "utf8")

  if (!truncate || buffer.byteLength <= OUTPUT_TRUNCATE_BYTES) {
    process.stdout.write(content)
    return
  }

  process.stdout.write(
    buffer.subarray(0, OUTPUT_TRUNCATE_BYTES).toString("utf8")
  )
  console.error(
    `Output truncated at ${OUTPUT_TRUNCATE_BYTES} bytes; use --output <file> or --output -.`
  )
}

function printRows(rows: Array<Record<string, unknown>>, columns: string[]) {
  console.log(columns.join("\t"))

  for (const row of rows) {
    console.log(columns.map((column) => String(row[column] ?? "")).join("\t"))
  }
}

function readFlag(args: string[], name: string) {
  const index = args.indexOf(name)

  if (index === -1) {
    return null
  }

  const value = args[index + 1]

  if (!value || value.startsWith("--")) {
    throw usage(`Missing value for ${name}`)
  }

  args.splice(index, 2)
  return value
}

function takeFlag(args: string[], name: string) {
  const index = args.indexOf(name)

  if (index === -1) {
    return false
  }

  args.splice(index, 1)
  return true
}

function validateSkillBundleResponse(bundle: unknown) {
  if (!bundle || typeof bundle !== "object") {
    throw usage("Invalid skill bundle response")
  }

  const record = bundle as { files?: unknown; version?: unknown }

  if (!Array.isArray(record.files)) {
    throw usage("Invalid skill bundle response")
  }

  const seen = new Set<string>()
  const files = record.files.map((file): SkillBundleFile => {
    if (
      !file ||
      typeof file !== "object" ||
      typeof (file as { path?: unknown }).path !== "string" ||
      typeof (file as { content?: unknown }).content !== "string"
    ) {
      throw usage("Invalid skill bundle file")
    }

    const skillFile = file as SkillBundleFile

    if (seen.has(skillFile.path)) {
      throw usage(`Duplicate skill bundle path: ${skillFile.path}`)
    }

    validateSkillBundlePath(skillFile.path)
    seen.add(skillFile.path)

    return skillFile
  })
  const skillFile = files.find((file) => file.path === "SKILL.md")

  if (!skillFile) {
    throw usage("Skill bundle is missing SKILL.md")
  }

  const frontmatter = parseSkillFrontmatter(skillFile.content)

  if (frontmatter.name !== AGENT_SKILL_NAME) {
    throw usage(
      `Skill bundle name must be ${AGENT_SKILL_NAME}; received ${frontmatter.name}`
    )
  }

  if (!frontmatter.description || frontmatter.description.length > 1024) {
    throw usage("Skill bundle description is invalid")
  }

  return {
    files,
    version: typeof record.version === "string" ? record.version : "unknown",
  }
}

function validateSkillBundlePath(filePath: string) {
  if (!filePath || path.isAbsolute(filePath) || filePath.includes("\\")) {
    throw usage(`Invalid skill bundle path: ${filePath}`)
  }

  const parts = filePath.split("/")

  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw usage(`Invalid skill bundle path: ${filePath}`)
  }

  if (
    filePath !== "SKILL.md" &&
    (parts.length !== 2 || parts[0] !== "providers")
  ) {
    throw usage(`Invalid skill bundle provider path: ${filePath}`)
  }
}

function parseSkillFrontmatter(content: string) {
  const lines = content.split("\n")

  if (lines[0] !== "---") {
    throw usage("Skill bundle SKILL.md is missing frontmatter")
  }

  const closeIndex = lines.indexOf("---", 1)

  if (closeIndex === -1) {
    throw usage("Skill bundle SKILL.md frontmatter is not closed")
  }

  const frontmatter: Record<string, string> = {}

  for (const line of lines.slice(1, closeIndex)) {
    const separator = line.indexOf(":")

    if (separator <= 0) {
      throw usage(`Invalid skill frontmatter line: ${line}`)
    }

    const key = line.slice(0, separator).trim()
    const rawValue = line.slice(separator + 1).trim()

    frontmatter[key] = parseSkillFrontmatterValue(rawValue)
  }

  return frontmatter
}

function parseSkillFrontmatterValue(value: string) {
  if (value.startsWith('"')) {
    const parsed = JSON.parse(value) as unknown

    if (typeof parsed !== "string") {
      throw usage("Skill frontmatter values must be strings")
    }

    return parsed
  }

  return value
}

function resolveInside(root: string, relativePath: string) {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw usage(`Invalid skill bundle path: ${relativePath}`)
  }

  const rootPath = path.resolve(root)
  const target = path.resolve(rootPath, relativePath)
  const relative = path.relative(rootPath, target)

  if (
    relative === "" ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw usage(`Invalid skill bundle path: ${relativePath}`)
  }

  return target
}

function exitCodeFor(code: string | undefined, status: number) {
  if (status === 401) return 3
  if (status === 403) return 4
  if (status === 429) return 6
  if (code?.startsWith("approval_") || code === "approval_required") {
    return 5
  }
  if (code?.startsWith("provider_")) return 1
  return 1
}

function usage(message: string) {
  const error = new Error(message) as CliError
  error.exitCode = 2
  return error
}

function printHelp() {
  console.log(`leme

Commands:
  leme login --token <token>
  leme logout
  leme whoami
  leme tools
  leme connections
  leme call <sdkName> [json] [--input-file file] [--approve-wait] [--output file|-]
  leme approvals wait <approvalId>
  leme init [--agents-md]

Exit codes:
  0  ok
  1  provider/internal failure
  2  usage error
  3  authentication error
  4  permission denied
  5  approval required, denied, expired, or timed out
  6  rate limited
`)
}

function printCallHelp() {
  console.log(`leme call

Usage:
  leme call <sdkName> [json] [--input-file file] [--approve-wait] [--output file|-]

Options:
  --input-file file   Read JSON input from a file.
  --approve-wait     Poll approval status and retry after approval.
  --output file      Write the complete JSON response to a file and print { savedTo, bytes }.
  --output -         Force the complete JSON response to stdout.
  --json             Force JSON output when stdout is a TTY.

Without --output, non-TTY stdout is truncated at ${OUTPUT_TRUNCATE_BYTES} bytes with a stderr warning.

Exit codes:
  0  ok
  1  provider/internal failure
  2  usage error
  3  authentication error
  4  permission denied
  5  approval required, denied, expired, or timed out
  6  rate limited
`)
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
