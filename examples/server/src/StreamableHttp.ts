import { randomUUID } from 'node:crypto';

import { setupAuthServer } from '@modelcontextprotocol/examples-shared';
import type {
    CallToolResult,
    GetPromptResult,
    OAuthMetadata,
    PrimitiveSchemaDefinition,
    ReadResourceResult,
    ResourceLink
} from '@modelcontextprotocol/server';
import {
    checkResourceAllowed,
    createMcpExpressApp,
    ElicitResultSchema,
    getOAuthProtectedResourceMetadataUrl,
    InMemoryTaskMessageQueue,
    InMemoryTaskStore,
    isInitializeRequest,
    mcpAuthMetadataRouter,
    McpServer,
    requireBearerAuth,
    StreamableHTTPServerTransport
} from '@modelcontextprotocol/server';
import type { Request, Response } from 'express';
import * as z from 'zod/v4';

import { InMemoryEventStore } from './inMemoryEventStore.js';
import { createCalendarClient } from './google_calendar/client/createCalendarClient.js';

// Check for OAuth flag
const useOAuth = process.argv.includes('--oauth');
const strictOAuth = process.argv.includes('--oauth-strict');

// Simple in-memory token storage
class InMemoryTokenStore {
    private tokens: Map<string, { access_token: string; refresh_token?: string }> = new Map();

    async setTokensForClient(clientId: string, tokens: { access_token: string; refresh_token?: string }) {
        this.tokens.set(clientId, tokens);
    }

    async getTokensForClient(clientId?: string): Promise<{ access_token: string; refresh_token?: string } | null> {
        if (!clientId) {
            // If no clientId provided, try to get the first available token
            const firstToken = this.tokens.values().next().value;
            return firstToken || null;
        }
        return this.tokens.get(clientId) || null;
    }

    async removeTokensForClient(clientId: string) {
        this.tokens.delete(clientId);
    }
}

// Create shared task store for demonstration
const taskStore = new InMemoryTaskStore();
const tokenStore = new InMemoryTokenStore();

// Load tokens from environment if available
if (process.env.GOOGLE_ACCESS_TOKEN) {
    tokenStore.setTokensForClient('default', {
        access_token: process.env.GOOGLE_ACCESS_TOKEN,
        refresh_token: process.env.GOOGLE_REFRESH_TOKEN
    });
    console.log('✅ Google OAuth tokens loaded from environment');
}

async function getUserTokens(clientId?: string): Promise<{ access_token: string; refresh_token?: string }> {
    const tokens = await tokenStore.getTokensForClient(clientId);
    if (!tokens) {
        throw new Error(`No tokens found for client${clientId ? ` '${clientId}'` : ''}. Please authenticate first.`);
    }
    return tokens;
}


// Create an MCP server with implementation details
const getServer = () => {
    const server = new McpServer(
        {
            name: 'streamable-http-server',
            version: '1.0.0',
            icons: [{ src: './mcp.svg', sizes: ['512x512'], mimeType: 'image/svg+xml' }],
            websiteUrl: 'https://github.com/modelcontextprotocol/typescript-sdk'
        },
        {
            capabilities: { logging: {}, tasks: { requests: { tools: { call: {} } } } },
            taskStore, // Enable task support
            taskMessageQueue: new InMemoryTaskMessageQueue()
        }
    );

    server.registerTool(
        'google_calendar_list_events',
        {
            title: 'List Events (Google Calendar)',
            description: 'ดึง event ของผู้ใช้จาก Google Calendar',
            inputSchema: {
                calendarId: z.string().default('primary').describe('Calendar ID (default: primary)'),
                maxResults: z.number().optional().default(50).describe('Maximum number of events to return'),
                timeMin: z.string().optional().describe('Lower bound for event start time (ISO datetime)'),
                timeMax: z.string().optional().describe('Upper bound for event start time (ISO datetime)'),
                query: z.string().optional().describe('Free text search terms to find events')
            }
        },
        async (input, context): Promise<CallToolResult> => {
            // Try to get tokens - will use first available if no clientId provided
            const tokens = await getUserTokens(context.authInfo?.clientId);
            const calendar = await createCalendarClient(tokens);

            const res = await calendar.events.list({
                calendarId: input.calendarId,
                maxResults: input.maxResults,
                timeMin: input.timeMin,
                timeMax: input.timeMax,
                q: input.query,
                singleEvents: true,
                orderBy: 'startTime'
            });

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(res.data.items, null, 2)
                    }
                ]
            };
        }
    );

    server.registerTool(
        'google_calendar_create_event',
        {
            title: 'Create Google Calendar Event',
            description: 'Create an event in Google Calendar',
            inputSchema: {
                title: z.string().describe('Event title'),
                description: z.string().optional().describe('Event description'),
                start: z.string().describe('ISO datetime with timezone (e.g., 2024-01-15T10:00:00+07:00)'),
                end: z.string().describe('ISO datetime with timezone (e.g., 2024-01-15T11:00:00+07:00)'),
                calendarId: z.string().default('primary').describe('Calendar ID (default: primary)'),
                attendees: z.array(z.string().email()).optional().describe('List of attendee email addresses')
            }
        },
        async (input, context): Promise<CallToolResult> => {
            // Try to get tokens - will use first available if no clientId provided
            const tokens = await getUserTokens(context.authInfo?.clientId);
            const calendar = await createCalendarClient(tokens);

            const event = await calendar.events.insert({
                calendarId: input.calendarId,
                requestBody: {
                    summary: input.title,
                    description: input.description,
                    start: {
                        dateTime: input.start
                    },
                    end: {
                        dateTime: input.end
                    },
                    attendees: input.attendees?.map(email => ({ email }))
                }
            });

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            eventId: event.data.id,
                            htmlLink: event.data.htmlLink,
                            summary: event.data.summary,
                            start: event.data.start,
                            end: event.data.end
                        }, null, 2)
                    }
                ]
            };
        }
    );


    // Register a simple tool that returns a greeting
    server.registerTool(
        'greet',
        {
            title: 'Greeting Tool', // Display name for UI
            description: 'A simple greeting tool',
            inputSchema: {
                name: z.string().describe('Name to greet')
            }
        },
        async ({ name }): Promise<CallToolResult> => {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Hello, ${name}!`
                    }
                ]
            };
        }
    );


    // Using the experimental tasks API - WARNING: may change without notice
    server.experimental.tasks.registerToolTask(
        'delay',
        {
            title: 'Delay',
            description: 'A simple tool that delays for a specified duration, useful for testing task execution',
            inputSchema: {
                duration: z.number().describe('Duration in milliseconds').default(5000)
            }
        },
        {
            async createTask({ duration }, { taskStore, taskRequestedTtl }) {
                // Create the task
                const task = await taskStore.createTask({
                    ttl: taskRequestedTtl
                });

                // Simulate out-of-band work
                (async () => {
                    await new Promise(resolve => setTimeout(resolve, duration));
                    await taskStore.storeTaskResult(task.taskId, 'completed', {
                        content: [
                            {
                                type: 'text',
                                text: `Completed ${duration}ms delay`
                            }
                        ]
                    });
                })();

                // Return CreateTaskResult with the created task
                return {
                    task
                };
            },
            async getTask(_args, { taskId, taskStore }) {
                return await taskStore.getTask(taskId);
            },
            async getTaskResult(_args, { taskId, taskStore }) {
                const result = await taskStore.getTaskResult(taskId);
                return result as CallToolResult;
            }
        }
    );

    return server;
};

const MCP_PORT = process.env.MCP_PORT ? parseInt(process.env.MCP_PORT, 10) : 4000;
const AUTH_PORT = process.env.MCP_AUTH_PORT ? parseInt(process.env.MCP_AUTH_PORT, 10) : 3001;

const app = createMcpExpressApp({
    host: '0.0.0.0',
    // allowedHosts: ['localhost', '127.0.0.1', 'host.docker.internal', "192.168.1.159"]
    allowedHosts: ['localhost', '127.0.0.1', 'host.docker.internal']
});

// Set up OAuth if enabled
let authMiddleware = null;
if (useOAuth) {
    // Create auth middleware for MCP endpoints
    const mcpServerUrl = new URL(`http://localhost:${MCP_PORT}/mcp`);
    const authServerUrl = new URL(`http://localhost:${AUTH_PORT}`);

    const oauthMetadata: OAuthMetadata = setupAuthServer({ authServerUrl, mcpServerUrl, strictResource: strictOAuth });

    const tokenVerifier = {
        verifyAccessToken: async (token: string) => {
            const endpoint = oauthMetadata.introspection_endpoint;

            if (!endpoint) {
                throw new Error('No token verification endpoint available in metadata');
            }

            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams({
                    token: token
                }).toString()
            });

            if (!response.ok) {
                const text = await response.text().catch(() => null);
                throw new Error(`Invalid or expired token: ${text}`);
            }

            const data = (await response.json()) as { aud: string; client_id: string; scope: string; exp: number };

            if (strictOAuth) {
                if (!data.aud) {
                    throw new Error(`Resource Indicator (RFC8707) missing`);
                }
                if (!checkResourceAllowed({ requestedResource: data.aud, configuredResource: mcpServerUrl })) {
                    throw new Error(`Expected resource indicator ${mcpServerUrl}, got: ${data.aud}`);
                }
            }

            // Convert the response to AuthInfo format
            return {
                token,
                clientId: data.client_id,
                scopes: data.scope ? data.scope.split(' ') : [],
                expiresAt: data.exp
            };
        }
    };
    // Add metadata routes to the main MCP server
    app.use(
        mcpAuthMetadataRouter({
            oauthMetadata,
            resourceServerUrl: mcpServerUrl,
            scopesSupported: ['mcp:tools'],
            resourceName: 'MCP Demo Server'
        })
    );

    authMiddleware = requireBearerAuth({
        verifier: tokenVerifier,
        requiredScopes: [],
        resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpServerUrl)
    });
}

// Map to store transports by session ID
const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

// MCP POST endpoint with optional auth
const mcpPostHandler = async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (sessionId) {
        console.log(`Received MCP request for session: ${sessionId}`);
    } else {
        console.log('Request body:', req.body);
    }

    if (useOAuth && req.auth) {
        console.log('Authenticated user:', req.auth);
    }
    try {
        let transport: StreamableHTTPServerTransport;
        if (sessionId && transports[sessionId]) {
            // Reuse existing transport
            transport = transports[sessionId];
        } else if (!sessionId && isInitializeRequest(req.body)) {
            // New initialization request
            const eventStore = new InMemoryEventStore();
            transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                eventStore, // Enable resumability
                onsessioninitialized: sessionId => {
                    console.log(`Session initialized with ID: ${sessionId}`);
                    transports[sessionId] = transport;
                }
            });

            // Set up onclose handler to clean up transport when closed
            transport.onclose = () => {
                const sid = transport.sessionId;
                if (sid && transports[sid]) {
                    console.log(`Transport closed for session ${sid}, removing from transports map`);
                    delete transports[sid];
                }
            };

            // so responses can flow back through the same transport
            const server = getServer();
            await server.connect(transport);

            await transport.handleRequest(req, res, req.body);
            return; // Already handled
        } else {
            // Invalid request - no session ID or not initialization request
            res.status(400).json({
                jsonrpc: '2.0',
                error: {
                    code: -32000,
                    message: 'Bad Request: No valid session ID provided'
                },
                id: null
            });
            return;
        }

        await transport.handleRequest(req, res, req.body);
    } catch (error) {
        console.error('Error handling MCP request:', error);
        if (!res.headersSent) {
            res.status(500).json({
                jsonrpc: '2.0',
                error: {
                    code: -32603,
                    message: 'Internal server error'
                },
                id: null
            });
        }
    }
};

// Set up routes with conditional auth middleware
if (useOAuth && authMiddleware) {
    app.post('/mcp', authMiddleware, mcpPostHandler);
} else {
    app.post('/mcp', mcpPostHandler);
}

// Handle GET requests for SSE streams (using built-in support from StreamableHTTP)
const mcpGetHandler = async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
        res.status(400).send('Invalid or missing session ID');
        return;
    }

    if (useOAuth && req.auth) {
        console.log('Authenticated SSE connection from user:', req.auth);
    }

    // Check for Last-Event-ID header for resumability
    const lastEventId = req.headers['last-event-id'] as string | undefined;
    if (lastEventId) {
        console.log(`Client reconnecting with Last-Event-ID: ${lastEventId}`);
    } else {
        console.log(`Establishing new SSE stream for session ${sessionId}`);
    }

    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
};

// Set up GET route with conditional auth middleware
if (useOAuth && authMiddleware) {
    app.get('/mcp', authMiddleware, mcpGetHandler);
} else {
    app.get('/mcp', mcpGetHandler);
}

// Handle DELETE requests for session termination (according to MCP spec)
const mcpDeleteHandler = async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
        res.status(400).send('Invalid or missing session ID');
        return;
    }

    console.log(`Received session termination request for session ${sessionId}`);

    try {
        const transport = transports[sessionId];
        await transport.handleRequest(req, res);
    } catch (error) {
        console.error('Error handling session termination:', error);
        if (!res.headersSent) {
            res.status(500).send('Error processing session termination');
        }
    }
};

// Set up DELETE route with conditional auth middleware
if (useOAuth && authMiddleware) {
    app.delete('/mcp', authMiddleware, mcpDeleteHandler);
} else {
    app.delete('/mcp', mcpDeleteHandler);
}

app.listen(MCP_PORT, error => {
    if (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
    console.log(`MCP Streamable HTTP Server listening on port ${MCP_PORT}`);
    console.log('\n📅 Google Calendar Tools Available:');
    console.log('   - google_calendar_list_events');
    console.log('   - google_calendar_create_event');
    console.log('\n🔑 To use Google Calendar tools, set up OAuth tokens:');
    console.log('   tokenStore.setTokensForClient("default", {');
    console.log('     access_token: "YOUR_GOOGLE_ACCESS_TOKEN",');
    console.log('     refresh_token: "YOUR_GOOGLE_REFRESH_TOKEN"');
    console.log('   });\n');
});

// Handle server shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down server...');

    // Close all active transports to properly clean up resources
    for (const sessionId in transports) {
        try {
            console.log(`Closing transport for session ${sessionId}`);
            await transports[sessionId]!.close();
            delete transports[sessionId];
        } catch (error) {
            console.error(`Error closing transport for session ${sessionId}:`, error);
        }
    }
    console.log('Server shutdown complete');
    process.exit(0);
});
