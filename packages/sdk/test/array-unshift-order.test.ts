import './util';
import { describe, test } from "vitest";
import { assert } from "chai";

import {
    Schema, ArraySchema, type, Encoder, Decoder, Reflection,
} from "@colyseus/schema";
import { SchemaSerializer } from "../src/serializer/SchemaSerializer.ts";

//
// "插队" regression: inserting at the FRONT of an ArraySchema (unshift) must
// not duplicate the previous first element on the decoding side.
//
//   room side:  [10, 20, 30].unshift(5) -> [5, 10, 20, 30]
//   wire side:  decode(patch)          -> [5, 10, 20, 30]  (NOT 5,10,10,20,30)
//
// The room's recorded order and the client's decoded order must always be the
// same sequence: same values, same order, same count.
//

class NumberQueueState extends Schema {
    @type(["number"])
    queue = new ArraySchema<number>();
}

function numberQueuePair() {
    const state = new NumberQueueState();
    const encoder = new Encoder(state);

    const remote = new NumberQueueState();
    const decoder = new Decoder(remote);

    return { state, encoder, remote, decoder };
}

describe("ArraySchema front-insert (unshift) keeps both sides identical", () => {
    test("unshift at front: 10,20,30 -> 5,10,20,30, no duplicated first item", () => {
        const { state, encoder, remote, decoder } = numberQueuePair();
        state.queue.push(10, 20, 30);
        decoder.decode(encoder.encodeAll());
        assert.deepEqual([...remote.queue], [10, 20, 30]);

        state.queue.unshift(5);
        const patch = encoder.encode();

        // The 10,20,30 -> 5,10,20,30 beat encodes as a 16-byte patch.
        assert.strictEqual(patch.length, 16);

        decoder.decode(patch);

        // One person, one number: 10 must not appear twice.
        assert.strictEqual(remote.queue.length, 4);
        assert.deepEqual([...remote.queue], [5, 10, 20, 30]);
        assert.deepEqual([...remote.queue], [...state.queue]);
    });

    test("second front-insert next tick: -> 7,5,10,20,30", () => {
        const { state, encoder, remote, decoder } = numberQueuePair();
        state.queue.push(10, 20, 30);
        decoder.decode(encoder.encodeAll());

        state.queue.unshift(5);
        decoder.decode(encoder.encode());
        encoder.discardChanges();

        state.queue.unshift(7);
        decoder.decode(encoder.encode());

        assert.strictEqual(remote.queue.length, 5);
        assert.deepEqual([...remote.queue], [7, 5, 10, 20, 30]);
        assert.deepEqual([...remote.queue], [...state.queue]);
    });

    test("removing the head keeps both sides aligned: 10,20,30 -> 20,30", () => {
        const { state, encoder, remote, decoder } = numberQueuePair();
        state.queue.push(10, 20, 30);
        decoder.decode(encoder.encodeAll());

        state.queue.shift();
        decoder.decode(encoder.encode());

        assert.deepEqual([...remote.queue], [20, 30]);
        assert.deepEqual([...remote.queue], [...state.queue]);
    });

    test("removing the middle keeps both sides aligned: 1,2,3 -> 1,3", () => {
        const { state, encoder, remote, decoder } = numberQueuePair();
        state.queue.push(1, 2, 3);
        decoder.decode(encoder.encodeAll());

        state.queue.splice(1, 1);
        decoder.decode(encoder.encode());

        assert.deepEqual([...remote.queue], [1, 3]);
        assert.deepEqual([...remote.queue], [...state.queue]);
    });

    test("appending at the tail still works after the front-insert fix", () => {
        const { state, encoder, remote, decoder } = numberQueuePair();
        state.queue.push(10, 20, 30);
        decoder.decode(encoder.encodeAll());

        state.queue.push(40);
        decoder.decode(encoder.encode());

        assert.deepEqual([...remote.queue], [10, 20, 30, 40]);
        assert.deepEqual([...remote.queue], [...state.queue]);
    });
});

class Entity extends Schema {
    @type("number") x = 0;
    @type("number") y = 0;
    @type("number") score = 0;
}

class WorldState extends Schema {
    @type([Entity])
    people = new ArraySchema<Entity>();
}

describe("ArraySchema front-insert of schema entities", () => {
    test("unshift keeps entity order, count and identity", () => {
        const state = new WorldState();
        const encoder = new Encoder(state);
        const remote = new WorldState();
        const decoder = new Decoder(remote);

        const a = new Entity().assign({ x: 10 });
        const b = new Entity().assign({ x: 20 });
        const c = new Entity().assign({ x: 30 });
        state.people.push(a, b, c);
        decoder.decode(encoder.encodeAll());

        const newcomer = new Entity().assign({ x: 5 });
        state.people.unshift(newcomer);
        decoder.decode(encoder.encode());

        assert.strictEqual(remote.people.length, 4);
        assert.deepEqual([...remote.people].map((p) => p.x), [5, 10, 20, 30]);
    });

    test("a coordinate written as 0 decodes as 0 — not empty/undefined", () => {
        const state = new WorldState();
        const encoder = new Encoder(state);
        const remote = new WorldState();
        const decoder = new Decoder(remote);

        const entity = new Entity().assign({ x: 120, y: 80, score: 7 });
        state.people.push(entity);
        decoder.decode(encoder.encodeAll());

        entity.x = 0;
        decoder.decode(encoder.encode());

        const decoded = remote.people[0];
        assert.strictEqual(decoded.x, 0);
        assert.strictEqual(decoded.y, 80);
        assert.strictEqual(decoded.score, 7);
    });
});

describe("front-insert through the client SchemaSerializer (the real decoder path)", () => {
    test("client setState + patch yields the same queue the room holds", () => {
        const state = new NumberQueueState();
        const encoder = new Encoder(state);
        state.queue.push(10, 20, 30);

        const client = new SchemaSerializer<NumberQueueState>();
        client.handshake(Reflection.encode(encoder));
        client.setState(encoder.encodeAll());

        state.queue.unshift(5);
        client.patch(encoder.encode());
        encoder.discardChanges();

        assert.deepEqual([...client.getState().queue], [5, 10, 20, 30]);

        state.queue.unshift(7);
        client.patch(encoder.encode());

        assert.deepEqual([...client.getState().queue], [7, 5, 10, 20, 30]);
    });
});
