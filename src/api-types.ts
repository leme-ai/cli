// Duplicated public /api/v1 HTTP shapes. Do not import the web app from the CLI
// runtime; packages/leme-cli/contracts/api-types.contract.ts checks drift.
export type ApiV1ErrorResponse = {
  error: {
    code: string
    httpStatus: number
    message: string
  }
}

export type PatMode = "read_only" | "read_write"

export type MeResponse = {
  organizationId: string
  projectId: string
  projectName: string
  tokenExpiresAt: number
  tokenMode: PatMode
  userId: string
}

export type ToolRisk =
  | "read"
  | "write"
  | "external_message"
  | "public_publish"
  | "destructive"
  | "payment"
  | "admin"

export type ToolSummary = {
  inputHint: {
    fields: string[]
    required: string[]
  }
  provider: string
  requiresApproval: boolean
  risk: ToolRisk
  sdkName: string
  summary: string
}

export type ToolsResponse = {
  tools: ToolSummary[]
}

export type ConnectionSummary = {
  connectedForYou: boolean
  connectionType: string
  name: string
  provider: string
  status: string
}

export type ConnectionsResponse = {
  connections: ConnectionSummary[]
}

export type ToolCallRequest = {
  approvalId?: string
  input?: Record<string, unknown>
  sdkName: string
}

export type ToolCallSuccessResponse = {
  latencyMs: number
  result: unknown
  sdkName: string
  status: "ok"
  toolName: string
}

export type ToolCallApprovalRequiredResponse = {
  approvalId: string
  latencyMs: number
  message: string
  sdkName: string
  status: "requires_approval"
  toolCallId: string
  toolName: string
}

export type ToolCallResponse =
  | ToolCallSuccessResponse
  | ToolCallApprovalRequiredResponse

export type ApprovalStatusResponse = {
  approvalId: string
  status: "pending" | "approved" | "denied" | "expired"
  toolCallId: string
}

export type SkillBundleFile = {
  content: string
  path: string
}

export type SkillBundleResponse = {
  files: SkillBundleFile[]
  version: string
}

export type ApiV1GetResponseByPath = {
  "/v1/approvals/:approvalId": ApprovalStatusResponse
  "/v1/connections": ConnectionsResponse
  "/v1/me": MeResponse
  "/v1/skills/leme": SkillBundleResponse
  "/v1/tools": ToolsResponse
}

export type ApiV1PostRequestByPath = {
  "/v1/tools/call": ToolCallRequest
}

export type ApiV1PostResponseByPath = {
  "/v1/tools/call": ToolCallResponse
}
