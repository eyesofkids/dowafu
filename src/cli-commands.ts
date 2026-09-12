// These spellings drive both dispatch and ticket-name validation.
export const CLI_COMMANDS = {
  ticket: "ticket", providers: "providers", token: "token", key: "key",
  result: "result", approve: "approve", serve: "serve", mcp: "mcp",
};
export const CLI_SHORTCUTS = { help: "-h", version: "-V" };

export function reservedTicketNames(): string[] {
  return [...Object.values(CLI_COMMANDS), ...Object.values(CLI_SHORTCUTS), "--*"];
}

export function isReservedTicketName(name: string): boolean {
  return name.startsWith("--") || reservedTicketNames().includes(name);
}

