'use strict';

// ─── Strategy ─────────────────────────────────────────────────────────────────
// supabaseService.js is a singleton (module.exports = new SupabaseService()).
// We mock the Supabase client and config before the module is loaded, then
// inject controlled DB responses through the mock's fluent builder chain.

// 1. Mock dotenv so config.js does not try to read a real .env
jest.mock('dotenv', () => ({ config: jest.fn() }));

// 2. Provide fake but valid-looking credentials so the constructor initialises
//    this.client (instead of falling back to null).
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_KEY = 'fake-key';

// 3. Mock @supabase/supabase-js before anything requires it
const mockSingle    = jest.fn();
const mockMaybeSingle = jest.fn();
const mockOrder     = jest.fn();
const mockLimit     = jest.fn();
const mockEq        = jest.fn();
const mockOr        = jest.fn();
const mockSelect    = jest.fn();
const mockInsert    = jest.fn();
const mockUpdate    = jest.fn();
const mockIn        = jest.fn();
const mockNot       = jest.fn();
const mockGte       = jest.fn();
const mockFrom      = jest.fn();

// Build the fluent mock chain — each builder method returns the chain object
// so callers can do client.from('x').select('y').eq('z', v).single() etc.
const chain = {
    select:      mockSelect,
    insert:      mockInsert,
    update:      mockUpdate,
    eq:          mockEq,
    or:          mockOr,
    not:         mockNot,
    in:          mockIn,
    gte:         mockGte,
    order:       mockOrder,
    limit:       mockLimit,
    single:      mockSingle,
    maybeSingle: mockMaybeSingle,
};

// Every builder method returns the chain so methods can be chained
Object.values(chain).forEach(fn => fn.mockReturnValue(chain));

mockFrom.mockReturnValue(chain);

jest.mock('@supabase/supabase-js', () => ({
    createClient: jest.fn(() => ({ from: mockFrom })),
}));

// Now require the service (singleton is created here)
const service = require('../core/supabaseService');

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Reset all mock call counters between tests */
function resetMocks() {
    Object.values(chain).forEach(fn => {
        fn.mockClear();
        fn.mockReturnValue(chain);
    });
    mockFrom.mockClear();
    mockFrom.mockReturnValue(chain);
}

// ─── getGraphByChannels ───────────────────────────────────────────────────────

describe('getGraphByChannels — filtering logic', () => {
    beforeEach(() => {
        resetMocks();
    });

    // Shared sample data used across tests
    const allNodes = [
        { id: 1, type: 'Employee',  name: 'Alice' },
        { id: 2, type: 'Client',    name: 'AcmeCo' },
        { id: 3, type: 'Product',   name: 'Widget' },
        { id: 4, type: 'Price',     name: 'PriceTag' },
        { id: 5, type: 'Deadline',  name: 'Q3 Launch' },
        { id: 6, type: 'Supplier',  name: 'SupplierX' },
        { id: 7, type: 'Unknown',   name: 'Junk' },
    ];

    const allEdges = [
        { id: 10, from_node_id: 1, to_node_id: 2 }, // Employee → Client
        { id: 11, from_node_id: 2, to_node_id: 3 }, // Client   → Product
        { id: 12, from_node_id: 3, to_node_id: 4 }, // Product  → Price
        { id: 13, from_node_id: 6, to_node_id: 2 }, // Supplier → Client
        { id: 14, from_node_id: 7, to_node_id: 1 }, // Unknown  → Employee (filtered)
    ];

    /**
     * Configure the fluent mock chain so that:
     * - first  from('nodes')  .select('*') resolves with allNodes
     * - second from('edges')  .select('*') resolves with allEdges
     * We achieve this by making mockSelect alternate responses.
     */
    function mockDbWithData(nodes = allNodes, edges = allEdges, nodeErr = null, edgeErr = null) {
        let callCount = 0;
        mockSelect.mockImplementation(() => {
            callCount++;
            // First call = nodes query, second = edges query
            if (callCount === 1) {
                return Promise.resolve({ data: nodes, error: nodeErr });
            }
            return Promise.resolve({ data: edges, error: edgeErr });
        });
    }

    test('returns empty result when channels array is empty', async () => {
        mockDbWithData();
        const result = await service.getGraphByChannels([]);
        expect(result).toEqual({ nodes: [], edges: [] });
    });

    test('returns empty result when channels array is null/undefined', async () => {
        mockDbWithData();
        const result = await service.getGraphByChannels(null);
        expect(result).toEqual({ nodes: [], edges: [] });
    });

    test('personal_whatsapp channel surfaces only Employee nodes', async () => {
        mockDbWithData();
        const { nodes } = await service.getGraphByChannels(['personal_whatsapp']);
        expect(nodes.every(n => n.type === 'Employee')).toBe(true);
        expect(nodes.map(n => n.name)).toContain('Alice');
    });

    test('personal_email channel surfaces only Employee nodes', async () => {
        mockDbWithData();
        const { nodes } = await service.getGraphByChannels(['personal_email']);
        expect(nodes.every(n => n.type === 'Employee')).toBe(true);
    });

    test('business_whatsapp channel includes Employee, Client, Product, Price, Deadline', async () => {
        mockDbWithData();
        const { nodes } = await service.getGraphByChannels(['business_whatsapp']);
        const types = new Set(nodes.map(n => n.type));
        expect(types).toContain('Employee');
        expect(types).toContain('Client');
        expect(types).toContain('Product');
        expect(types).toContain('Price');
        expect(types).toContain('Deadline');
        // Unknown / Supplier should be excluded
        expect(types).not.toContain('Supplier');
        expect(types).not.toContain('Unknown');
    });

    test('business_email channel includes Employee, Client, Price, Deadline', async () => {
        mockDbWithData();
        const { nodes } = await service.getGraphByChannels(['business_email']);
        const types = new Set(nodes.map(n => n.type));
        expect(types).toContain('Employee');
        expect(types).toContain('Client');
        expect(types).toContain('Price');
        expect(types).toContain('Deadline');
        expect(types).not.toContain('Product');
        expect(types).not.toContain('Supplier');
    });

    test('business_info channel includes Client, Supplier, Product', async () => {
        mockDbWithData();
        const { nodes } = await service.getGraphByChannels(['business_info']);
        const types = new Set(nodes.map(n => n.type));
        expect(types).toContain('Client');
        expect(types).toContain('Supplier');
        expect(types).toContain('Product');
        expect(types).not.toContain('Employee');
    });

    test('unknown channel returns empty nodes (no matching type map entry)', async () => {
        mockDbWithData();
        const { nodes } = await service.getGraphByChannels(['nonexistent_channel']);
        expect(nodes).toEqual([]);
    });

    test('combining channels merges allowed types (union, no duplicates)', async () => {
        mockDbWithData();
        // personal_whatsapp = [Employee], business_info = [Client, Supplier, Product]
        const { nodes } = await service.getGraphByChannels(['personal_whatsapp', 'business_info']);
        const types = new Set(nodes.map(n => n.type));
        expect(types).toContain('Employee');
        expect(types).toContain('Client');
        expect(types).toContain('Supplier');
        expect(types).toContain('Product');
    });

    test('edges are included only when both endpoint node ids are in the filtered set', async () => {
        mockDbWithData();
        // business_whatsapp allows Employee(1), Client(2), Product(3), Price(4), Deadline(5)
        const { edges } = await service.getGraphByChannels(['business_whatsapp']);
        const edgeIds = edges.map(e => e.id);
        // Edge 10: 1→2 Employee→Client — both allowed
        expect(edgeIds).toContain(10);
        // Edge 11: 2→3 Client→Product — both allowed
        expect(edgeIds).toContain(11);
        // Edge 12: 3→4 Product→Price — both allowed
        expect(edgeIds).toContain(12);
        // Edge 13: 6→2 Supplier(6 not in set)→Client — excluded
        expect(edgeIds).not.toContain(13);
        // Edge 14: 7→1 Unknown→Employee — excluded
        expect(edgeIds).not.toContain(14);
    });

    test('returns empty edges array when nodes result is empty', async () => {
        mockDbWithData([], allEdges);
        const { edges } = await service.getGraphByChannels(['business_whatsapp']);
        expect(edges).toEqual([]);
    });

    test('returns empty nodes/edges when DB returns error on nodes', async () => {
        mockDbWithData(null, null, new Error('db error'));
        const result = await service.getGraphByChannels(['business_whatsapp']);
        expect(result).toEqual({ nodes: [], edges: [] });
    });

    test('returns empty nodes/edges when DB returns error on edges', async () => {
        // Provide a node success then edges error
        let callCount = 0;
        mockSelect.mockImplementation(() => {
            callCount++;
            if (callCount === 1) return Promise.resolve({ data: allNodes, error: null });
            return Promise.resolve({ data: null, error: new Error('edge db error') });
        });
        const result = await service.getGraphByChannels(['business_whatsapp']);
        expect(result).toEqual({ nodes: [], edges: [] });
    });

    test('handles nodes list being null from DB gracefully', async () => {
        mockDbWithData(null, []);
        const result = await service.getGraphByChannels(['business_whatsapp']);
        // null allNodes coerced to [] by the (allNodes || []) guard
        expect(result.nodes).toEqual([]);
        expect(result.edges).toEqual([]);
    });
});

// ─── getPendingReplies — conversation grouping logic ──────────────────────────

describe('getPendingReplies — grouping and filtering', () => {
    beforeEach(() => {
        resetMocks();
    });

    const now = new Date();
    const twoMinutesAgo = new Date(now - 2 * 60 * 1000).toISOString();

    function buildEmail({ id, sender, receiver, threadId, emailId }) {
        return {
            id,
            sender,
            receiver,
            threadId: threadId || null,
            created_at: twoMinutesAgo,
            employeeId: 1,
            oppositionId: null,
            employees: {
                Name:    'Alice',
                Mobile:  '9999',
                contact: null,
                emailId: emailId || 'alice@co.com'
            }
        };
    }

    function mockEmailQuery(emails) {
        mockLimit.mockResolvedValue({ data: emails, error: null });
    }

    test('returns empty array when DB has no emails', async () => {
        mockLimit.mockResolvedValue({ data: [], error: null });
        const result = await service.getPendingReplies();
        expect(result).toEqual([]);
    });

    test('returns empty array when DB errors', async () => {
        mockLimit.mockResolvedValue({ data: null, error: new Error('db fail') });
        const result = await service.getPendingReplies();
        expect(result).toEqual([]);
    });

    test('marks thread as pending when last sender is NOT the employee', async () => {
        // Last sender is a client (not the employee's emailId)
        const emails = [
            buildEmail({ id: 1, sender: 'client@acme.com', receiver: 'alice@co.com', threadId: 'thread-1', emailId: 'alice@co.com' }),
        ];
        mockEmailQuery(emails);
        const result = await service.getPendingReplies();
        expect(result.length).toBe(1);
        expect(result[0].client).toBe('client@acme.com');
    });

    test('does NOT mark thread as pending when last sender is the employee', async () => {
        const emails = [
            buildEmail({ id: 1, sender: 'alice@co.com', receiver: 'client@acme.com', threadId: 'thread-2', emailId: 'alice@co.com' }),
        ];
        mockEmailQuery(emails);
        const result = await service.getPendingReplies();
        expect(result).toEqual([]);
    });

    test('comparison is case-insensitive (trimmed)', async () => {
        // Sender is employee email but with different case — should NOT be pending
        const emails = [
            buildEmail({ id: 1, sender: '  Alice@Co.COM  ', receiver: 'client@x.com', threadId: 't3', emailId: 'alice@co.com' }),
        ];
        mockEmailQuery(emails);
        const result = await service.getPendingReplies();
        expect(result).toEqual([]);
    });

    test('groups by threadId so only the first (most recent) email per thread is evaluated', async () => {
        // Two emails in the same thread — most recent first (order desc from DB)
        // First = client message (pending), second = employee message (earlier, ignored)
        const emails = [
            buildEmail({ id: 2, sender: 'client@x.com', receiver: 'alice@co.com', threadId: 'thread-A', emailId: 'alice@co.com' }),
            buildEmail({ id: 1, sender: 'alice@co.com', receiver: 'client@x.com', threadId: 'thread-A', emailId: 'alice@co.com' }),
        ];
        mockEmailQuery(emails);
        const result = await service.getPendingReplies();
        // One thread, last message is from client → pending
        expect(result.length).toBe(1);
    });

    test('threads with no employee record are ignored', async () => {
        const emails = [
            {
                id: 1, sender: 'client@x.com', receiver: 'nobody@co.com',
                threadId: 'thread-Z', created_at: twoMinutesAgo,
                employeeId: null, oppositionId: null,
                employees: null  // no employee joined
            }
        ];
        mockEmailQuery(emails);
        const result = await service.getPendingReplies();
        expect(result).toEqual([]);
    });

    test('uses fallback threadId key when threadId is null', async () => {
        // Two emails with null threadId but same sender/receiver are grouped separately
        // because the key includes sender+receiver
        const emails = [
            buildEmail({ id: 1, sender: 'client@x.com', receiver: 'alice@co.com', threadId: null, emailId: 'alice@co.com' }),
            buildEmail({ id: 2, sender: 'client2@x.com', receiver: 'alice@co.com', threadId: null, emailId: 'alice@co.com' }),
        ];
        mockEmailQuery(emails);
        const result = await service.getPendingReplies();
        // Both are from different senders so 2 separate pseudo-threads, both pending
        expect(result.length).toBe(2);
    });

    test('includes waitTime as a non-negative integer', async () => {
        const emails = [
            buildEmail({ id: 1, sender: 'client@x.com', receiver: 'alice@co.com', threadId: 'th1', emailId: 'alice@co.com' })
        ];
        mockEmailQuery(emails);
        const [item] = await service.getPendingReplies();
        expect(typeof item.waitTime).toBe('number');
        expect(item.waitTime).toBeGreaterThanOrEqual(0);
    });
});
