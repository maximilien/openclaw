import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Command } from "commander";
import matter from "gray-matter";
import { colorize, theme } from "../terminal/theme.js";
import { formatErrorMessage } from "./cli-utils.js";
import { GatewayClient } from "../gateway/client.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { GATEWAY_CLIENT_NAMES, GATEWAY_CLIENT_MODES } from "../gateway/protocol/client-info.js";

const WORKSPACE_DIR = path.join(os.homedir(), ".openclaw", "workspace");
const WORKFLOWS_DIR = path.join(WORKSPACE_DIR, "WORKFLOWS");
const EXECUTIONS_DIR = path.join(WORKFLOWS_DIR, "executions");

interface WorkflowExecutionParticipant {
  agentId: string;
  agentName: string;
  status: "pending" | "running" | "completed" | "failed";
  startedAt?: string;
  completedAt?: string;
  result?: any;
  error?: string;
}

interface WorkflowExecution {
  id: string;
  workflowId: string;
  startedAt: string;
  completedAt?: string;
  status: "running" | "completed" | "failed" | "paused";
  triggerType: "scheduled" | "manual" | "agent";
  triggeredBy?: string;
  participants: WorkflowExecutionParticipant[];
  logs: string[];
}

interface Workflow {
  id: string;
  name: string;
  description: string;
  schedule: string;
  enabled: boolean;
  targeting: {
    communities: string[];
    groups: string[];
    tags: string[];
    agents: string[];
  };
  created: string;
  modified: string;
  author: string;
  owner?: string;
  executionMode: "automated" | "managed";
  content: string;
}

interface AgentConfig {
  gateway?: {
    port?: number;
    auth?: {
      token?: string;
    };
  };
}

async function loadWorkflow(workflowId: string): Promise<Workflow | null> {
  const filePath = path.join(WORKFLOWS_DIR, `${workflowId}.md`);

  if (!fsSync.existsSync(filePath)) {
    return null;
  }

  try {
    const fileContent = await fs.readFile(filePath, "utf-8");
    const { data, content } = matter(fileContent);

    return {
      id: workflowId,
      name: data.name || "",
      description: data.description || "",
      schedule: data.schedule || "",
      enabled: data.enabled !== false,
      targeting: data.targeting || { communities: [], groups: [], tags: [], agents: [] },
      created: data.created || new Date().toISOString(),
      modified: data.modified || new Date().toISOString(),
      author: data.author || "",
      owner: data.owner,
      executionMode: data.executionMode || "automated",
      content: content.trim(),
    };
  } catch (error) {
    console.error(`Error parsing workflow ${workflowId}:`, error);
    return null;
  }
}

async function loadExecution(
  workflowId: string,
  executionId: string,
): Promise<WorkflowExecution | null> {
  const filePath = path.join(EXECUTIONS_DIR, workflowId, `${executionId}.json`);

  if (!fsSync.existsSync(filePath)) {
    return null;
  }

  try {
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content);
  } catch (error) {
    console.error(`Error reading execution ${executionId}:`, error);
    return null;
  }
}

async function saveExecution(
  workflowId: string,
  execution: WorkflowExecution,
): Promise<void> {
  const filePath = path.join(EXECUTIONS_DIR, workflowId, `${execution.id}.json`);
  await fs.writeFile(filePath, JSON.stringify(execution, null, 2), "utf-8");
}

async function getAgentConfig(agentId: string): Promise<AgentConfig | null> {
  // Try per-agent workspace first
  let configPath = path.join(WORKSPACE_DIR, agentId, "openclaw.json");

  if (!fsSync.existsSync(configPath)) {
    // Try profile workspace
    configPath = path.join(os.homedir(), `.openclaw-${agentId}`, "openclaw.json");
  }

  if (!fsSync.existsSync(configPath)) {
    // Try default OpenClaw config (shared gateway)
    configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
  }

  if (!fsSync.existsSync(configPath)) {
    return null;
  }

  try {
    const content = await fs.readFile(configPath, "utf-8");
    return JSON.parse(content);
  } catch (error) {
    console.error(`Error reading agent config for ${agentId}:`, error);
    return null;
  }
}

async function sendWorkflowToAgent(
  agentId: string,
  agentName: string,
  workflow: Workflow,
  execution: WorkflowExecution,
): Promise<{ success: boolean; result?: any; error?: string }> {
  const config = await getAgentConfig(agentId);

  if (!config?.gateway?.port) {
    return {
      success: false,
      error: `Gateway not configured for agent ${agentId}`,
    };
  }

  const { port } = config.gateway;
  const wsUrl = `ws://127.0.0.1:${port}`;
  const deviceIdentity = loadOrCreateDeviceIdentity();

  return new Promise((resolve) => {
    let client: GatewayClient | undefined;
    let responseText = "";
    const timeout = setTimeout(() => {
      client?.stop();
      resolve({
        success: false,
        error: "Timeout waiting for agent response",
      });
    }, 120000); // 2 minute timeout

    try {
      client = new GatewayClient({
        url: wsUrl,
        clientName: GATEWAY_CLIENT_NAMES.CLI,
        clientDisplayName: `workflow-${execution.id}`,
        clientVersion: "1.0.0",
        platform: "node",
        mode: GATEWAY_CLIENT_MODES.CLI,
        deviceIdentity,
        onHelloOk: async () => {
          try {
            // Send workflow to agent via chat.send
            const sessionKey = `workflow-${execution.id}-${agentId}`;
            const message = `[Agent: ${agentName}]\n\n# Workflow: ${workflow.name}\n\n${workflow.content}`;

            await client!.request("chat.send", {
              message,
              sessionKey,
              idempotencyKey: `workflow-${execution.id}-${agentId}-${Date.now()}`,
            });
          } catch (error: any) {
            clearTimeout(timeout);
            client?.stop();
            resolve({
              success: false,
              error: `Failed to send workflow: ${error.message}`,
            });
          }
        },
        onConnectError: (error) => {
          clearTimeout(timeout);
          client?.stop();
          resolve({
            success: false,
            error: `Connect failed: ${error.message}`,
          });
        },
        onClose: (code, reason) => {
          clearTimeout(timeout);
          // Normal closure (1000) is success even if responseText is empty (tool-only execution)
          if (code === 1000) {
            resolve({
              success: true,
              result: { response: responseText || "(completed - tool-only execution)" },
            });
          } else if (responseText) {
            resolve({
              success: true,
              result: { response: responseText },
            });
          } else {
            resolve({
              success: false,
              error: `Connection closed (${code}): ${reason}`,
            });
          }
        },
        onEvent: (event) => {
          // Handle chat events - event name is "chat", state is in payload
          if (event.event === "chat" && event.payload) {
            const payload = event.payload as any;

            if (payload.state === "delta" && payload.text) {
              responseText += payload.text;
            }

            if (payload.state === "final") {
              if (payload.text) {
                responseText += payload.text;
              }
              clearTimeout(timeout);
              client?.stop();
              resolve({
                success: true,
                result: {
                  response: responseText || "(completed - tool-only execution)",
                },
              });
            }
          }
        },
      });

      client.start();
    } catch (error: any) {
      clearTimeout(timeout);
      client?.stop();
      resolve({
        success: false,
        error: `Failed to connect: ${error.message}`,
      });
    }
  });
}

async function runWorkflow(workflowId: string): Promise<void> {
  console.log(colorize(`Running workflow: ${workflowId}`, theme.accent));

  // Load workflow
  const workflow = await loadWorkflow(workflowId);
  if (!workflow) {
    console.error(colorize(`Workflow ${workflowId} not found`, theme.error));
    process.exit(1);
  }

  console.log(`Workflow: ${workflow.name}`);
  console.log(`Description: ${workflow.description}`);

  // Find the most recent running execution for this workflow
  const executionsDir = path.join(EXECUTIONS_DIR, workflowId);

  if (!fsSync.existsSync(executionsDir)) {
    console.error(colorize("No executions found for this workflow", theme.error));
    process.exit(1);
  }

  const executionFiles = await fs.readdir(executionsDir);
  const jsonFiles = executionFiles
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse(); // Most recent first

  let execution: WorkflowExecution | null = null;

  for (const file of jsonFiles) {
    const execId = path.basename(file, ".json");
    const exec = await loadExecution(workflowId, execId);
    if (exec && exec.status === "running") {
      execution = exec;
      break;
    }
  }

  if (!execution) {
    console.error(colorize("No running execution found", theme.error));
    process.exit(1);
  }

  console.log(`\nExecution ID: ${execution.id}`);
  console.log(`Participants: ${execution.participants.length}`);

  // Add log entry
  execution.logs.push(`Workflow execution started by CLI at ${new Date().toISOString()}`);
  await saveExecution(workflowId, execution);

  // Process each participant
  for (const participant of execution.participants) {
    console.log(`\n${colorize("→", theme.accent)} Processing ${participant.agentName}...`);

    // Update participant status to running
    participant.status = "running";
    participant.startedAt = new Date().toISOString();
    execution.logs.push(`Started execution for ${participant.agentName}`);
    await saveExecution(workflowId, execution);

    // Send workflow to agent
    const result = await sendWorkflowToAgent(
      participant.agentId,
      participant.agentName,
      workflow,
      execution,
    );

    if (result.success) {
      console.log(colorize(`  ✓ ${participant.agentName} completed`, theme.success));
      participant.status = "completed";
      participant.completedAt = new Date().toISOString();
      participant.result = result.result;
      execution.logs.push(`${participant.agentName} completed successfully`);
    } else {
      console.error(
        colorize(`  ✗ ${participant.agentName} failed: ${result.error}`, theme.error),
      );
      participant.status = "failed";
      participant.completedAt = new Date().toISOString();
      participant.error = result.error;
      execution.logs.push(`${participant.agentName} failed: ${result.error}`);
    }

    await saveExecution(workflowId, execution);
  }

  // Mark execution as complete
  const allCompleted = execution.participants.every(
    (p) => p.status === "completed" || p.status === "failed",
  );
  const anyFailed = execution.participants.some((p) => p.status === "failed");

  execution.status = anyFailed ? "failed" : "completed";
  execution.completedAt = new Date().toISOString();
  execution.logs.push(
    `Workflow execution ${execution.status} at ${execution.completedAt}`,
  );
  await saveExecution(workflowId, execution);

  console.log(
    `\n${colorize("✓", theme.success)} Workflow execution ${execution.status}`,
  );

  // Summary
  const completed = execution.participants.filter((p) => p.status === "completed").length;
  const failed = execution.participants.filter((p) => p.status === "failed").length;
  console.log(`Summary: ${completed} succeeded, ${failed} failed`);

  process.exit(anyFailed ? 1 : 0);
}

export function registerWorkflowCli(program: Command): void {
  const workflow = program
    .command("workflow")
    .description("Manage and execute workflows");

  workflow
    .command("run <workflowId>")
    .description("Execute a workflow and update execution status")
    .action(async (workflowId: string) => {
      try {
        await runWorkflow(workflowId);
      } catch (error: any) {
        console.error(formatErrorMessage(error));
        process.exit(1);
      }
    });
}
