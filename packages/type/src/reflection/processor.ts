/*
 * Deepkit Framework
 * Copyright (c) Deepkit UG, Marc J. Schmidt
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the MIT License.
 *
 * You should have received a copy of the MIT License along with this program.
 */

import {
    Annotations,
    CartesianProduct,
    defaultAnnotation,
    flattenUnionTypes,
    getAnnotations,
    getMember,
    indexAccess,
    isPrimitive,
    isType,
    isTypeIncluded,
    isWithAnnotations,
    MappedModifier,
    merge,
    narrowOriginalLiteral,
    OuterType,
    ReflectionKind,
    ReflectionOp,
    ReflectionVisibility,
    Type,
    TypeBaseMember,
    TypeClass,
    typeDecorators,
    TypeEnumMember,
    TypeFunction,
    TypeIndexSignature,
    TypeInfer,
    TypeLiteral,
    TypeMethod,
    TypeMethodSignature,
    TypeObjectLiteral,
    TypeParameter,
    TypeProperty,
    TypePropertySignature,
    TypeTemplateLiteral,
    TypeTupleMember,
    TypeUnion,
    unboxUnion,
    validationAnnotation,
    widenLiteral
} from './type';
import { isExtendable } from './extends';
import { ClassType, isArray, isClass, isFunction } from '@deepkit/core';
import { isWithDeferredDecorators } from '../decorator';
import { TData } from './reflection';

export type RuntimeStackEntry = Type | Object | (() => ClassType | Object) | string | number | boolean | bigint;

export type Packed = (RuntimeStackEntry | string)[] & { __is?: (data: any) => boolean } & { __type?: OuterType } & { __unpack?: PackStruct };

export class PackStruct {
    constructor(
        public ops: ReflectionOp[] = [],
        public stack: RuntimeStackEntry[] = [],
    ) {
    }
}

function unpackOps(decodedOps: ReflectionOp[], encodedOPs: string): void {
    for (let i = 0; i < encodedOPs.length; i++) {
        decodedOps.push(encodedOPs.charCodeAt(i) - 33);
    }
}

export function encodeOps(ops: ReflectionOp[]): string {
    return ops.map(v => String.fromCharCode(v + 33)).join('');
}

/**
 * Pack a pack structure (op instructions + pre-defined stack) and create a encoded version of it.
 */
export function pack(packOrOps: PackStruct | ReflectionOp[]): Packed {
    const ops = isArray(packOrOps) ? packOrOps : packOrOps.ops;
    const encodedOps = encodeOps(ops);

    if (!isArray(packOrOps)) {
        if (packOrOps.stack.length) {
            return [...packOrOps.stack as RuntimeStackEntry[], encodedOps];
        }
    }

    return [encodedOps];
}

export function unpack(pack: Packed): PackStruct {
    const ops: ReflectionOp[] = [];

    const encodedOPs = pack[pack.length - 1];

    //the end has always to be a string
    if ('string' !== typeof encodedOPs) return { ops: [], stack: [] };

    unpackOps(ops, encodedOPs);

    return { ops, stack: pack.length > 1 ? pack.slice(0, -1) : [] };
}

export function resolvePacked(type: Packed, args: any[] = []): OuterType {
    return resolveRuntimeType(type, args) as OuterType;
}

function isPack(o: any): o is Packed {
    return isArray(o);
}

/**
 * Computes a type of given object. This function caches the result on the object itself.
 */
export function resolveRuntimeType(o: ClassType | Function | Packed | any, args: any[] = []): OuterType {
    const type = Processor.get().reflect(o, args, { reuseCached: true });

    if (isType(type)) {
        return type as OuterType;
    }

    throw new Error('No type returned from runtime type program');
}

interface Frame {
    index: number;
    startIndex: number; //when the frame started, index of the stack
    variables: number;
    inputs: RuntimeStackEntry[];
    previous?: Frame;
    mappedType?: Loop;
    distributiveLoop?: Loop;
}

class Loop {
    private types: Type[] = [];
    private i: number = 0;

    constructor(private fromType: Type) {
        if (fromType.kind === ReflectionKind.union) {
            this.types = fromType.types;
        } else {
            this.types = [fromType];
        }
    }

    next(): Type | undefined {
        return this.types[this.i++];
    }
}

interface Program {
    frame: Frame;
    stack: (RuntimeStackEntry | Type)[];
    stackPointer: number; //pointer to the stack
    program: number; //pointer to the current op
    depth: number;
    initialStack: (RuntimeStackEntry | Type)[];
    resultType: Type;
    ops: ReflectionOp[];
    end: number;
    inputs: RuntimeStackEntry[];
    resultTypes?: Type[];
    typeParameters?: OuterType[];
    previous?: Program;
    object?: ClassType | Function | Packed | any;
}

function isConditionTruthy(condition: Type | number): boolean {
    if ('number' === typeof condition) return condition !== 0;
    return !!(condition.kind === ReflectionKind.literal && condition.literal);
}

function createProgram(options: Partial<Program>, inputs?: RuntimeStackEntry[]): Program {
    const program: Program = {
        frame: { index: 0, startIndex: -1, inputs: inputs || [], variables: 0, previous: undefined },
        stack: options.stack || [],
        stackPointer: options.stackPointer ?? -1,
        program: 0,
        depth: 0,
        initialStack: options.initialStack || [],
        resultType: options.resultType || { kind: ReflectionKind.unknown },
        ops: options.ops || [],
        end: options.end ?? (options.ops ? options.ops.length : 0),
        inputs: inputs || [],
        // resultTypes: [],
        // typeParameters: [],
        // previous: undefined,
        object: options.object,
    };

    if (options.initialStack) for (let i = 0; i < options.initialStack.length; i++) {
        if (i < program.stack.length) {
            program.stack[i] = options.initialStack[i];
        } else {
            program.stack.push(options.initialStack[i]);
        }
    }

    program.stackPointer = options.initialStack ? options.initialStack.length - 1 : -1;
    program.frame.startIndex = program.stackPointer;

    return program;
}

export class Processor {
    static typeProcessor?: Processor;

    static get(): Processor {
        return Processor.typeProcessor ||= new Processor();
    }

    /**
     * Linked list of programs to execute. For each external call to external program will this be changed.
     */
    protected program: Program = {
        frame: { index: 0, startIndex: -1, inputs: [], variables: 0 },
        stack: [],
        stackPointer: -1,
        program: 0,
        depth: 0,
        initialStack: [],
        resultType: { kind: ReflectionKind.unknown },
        // resultTypes: [],
        inputs: [],
        end: 0,
        ops: [],
        // previous: undefined,
        // object: undefined,
    };

    reflect(object: ClassType | Function | Packed | any, inputs: RuntimeStackEntry[] = [], options: { reuseCached?: boolean } = {}): Type {
        const packed: Packed | undefined = isPack(object) ? object : object.__type;
        if (!packed) {
            throw new Error('No valid runtime type given. Is @deepkit/type correctly installed? Execute deepkit-type-install to check');
        }

        let current: Program | undefined = this.program;
        //this check if there is an active program still running for given packed. if so, issue a new reference.
        //this reference is changed (its content only via Object.assign(reference, computedValues)) once the program finished.
        //this is independent of reuseCache since it's the cache for the current 'run', not a global cache
        while (current) {
            if (current.object === object) {
                //issue a new reference
                if (!current.resultTypes) current.resultTypes = [];
                const ref: Type = { kind: ReflectionKind.unknown };
                current.resultTypes.push(ref);
                return ref;
            }

            current = current.previous;
        }

        //the cache of already computed types is stored on the Packed (the array of the type program) because it's a static object that never changes
        //and will be GC correctly (and with it this cache). Its crucial that not all reflect() calls cache the content, otherwise it would pollute the
        //memory with useless types. For example a global type Partial<> would hold all its instances, what we do not want.
        //We cache only direct non-generic (inputs empty) types passed to typeOf<>() or resolveRuntimeType(). all other reflect() calls do not use this cache.
        if (options.reuseCached) {
            //make sure the same type is returned if already known
            if (packed.__type && inputs.length === 0) {
                return packed.__type;
            }
        }

        const pack = packed.__unpack ||= unpack(packed);
        const type = this.run(pack.ops, pack.stack, inputs, object) as OuterType;

        if (options.reuseCached && inputs.length === 0) {
            packed.__type = type;
        }

        return type;
    }

    run(ops: ReflectionOp[], initialStack: RuntimeStackEntry[], inputs: RuntimeStackEntry[] = [], object?: ClassType | Function | Packed | any): Type {
        return this.runProgram(createProgram({ ops, initialStack, object }, inputs));
    }

    runProgram(program: Program): Type {
        const loopRunning = this.program.end !== 0;
        program.previous = this.program;
        program.depth = this.program.depth + 1;
        this.program = program;
        if (!loopRunning) {
            return this.loop(program) as OuterType;
        }

        return program.resultType;
    }

    protected isEnded(): boolean {
        return this.program.program + 1 >= this.program.end;
    }

    /**
     * Runs all scheduled programs until termination.
     */
    protected loop(until?: Program): Type | RuntimeStackEntry {
        let result = this.program.stack[0];

        programLoop:
            while (this.program.end !== 0) {
                const program = this.program;
                for (; program.program < program.end; program.program++) {
                    const op = program.ops[program.program];

                    // process.stdout.write(`[${program.frame.index}] step ${program} ${ReflectionOp[op]}\n`);
                    switch (op) {
                        case ReflectionOp.string:
                            this.pushType({ kind: ReflectionKind.string });
                            break;
                        case ReflectionOp.number:
                            this.pushType({ kind: ReflectionKind.number });
                            break;
                        case ReflectionOp.numberBrand:
                            const ref = this.eatParameter() as number;
                            this.pushType({ kind: ReflectionKind.number, brand: ref });
                            break;
                        case ReflectionOp.boolean:
                            this.pushType({ kind: ReflectionKind.boolean });
                            break;
                        case ReflectionOp.void:
                            this.pushType({ kind: ReflectionKind.void });
                            break;
                        case ReflectionOp.unknown:
                            this.pushType({ kind: ReflectionKind.unknown });
                            break;
                        case ReflectionOp.object:
                            this.pushType({ kind: ReflectionKind.object });
                            break;
                        case ReflectionOp.never:
                            this.pushType({ kind: ReflectionKind.never });
                            break;
                        case ReflectionOp.undefined:
                            this.pushType({ kind: ReflectionKind.undefined });
                            break;
                        case ReflectionOp.bigint:
                            this.pushType({ kind: ReflectionKind.bigint });
                            break;
                        case ReflectionOp.symbol:
                            this.pushType({ kind: ReflectionKind.symbol });
                            break;
                        case ReflectionOp.null:
                            this.pushType({ kind: ReflectionKind.null });
                            break;
                        case ReflectionOp.any:
                            this.pushType({ kind: ReflectionKind.any });
                            break;
                        case ReflectionOp.literal: {
                            const ref = this.eatParameter() as number;
                            this.pushType({ kind: ReflectionKind.literal, literal: program.stack[ref] as string | number | boolean | bigint });
                            break;
                        }
                        case ReflectionOp.templateLiteral: {
                            this.handleTemplateLiteral();
                            break;
                        }
                        case ReflectionOp.date:
                            this.pushType({ kind: ReflectionKind.class, classType: Date, types: [] });
                            break;
                        case ReflectionOp.uint8Array:
                            this.pushType({ kind: ReflectionKind.class, classType: Uint8Array, types: [] });
                            break;
                        case ReflectionOp.int8Array:
                            this.pushType({ kind: ReflectionKind.class, classType: Int8Array, types: [] });
                            break;
                        case ReflectionOp.uint8ClampedArray:
                            this.pushType({ kind: ReflectionKind.class, classType: Uint8ClampedArray, types: [] });
                            break;
                        case ReflectionOp.uint16Array:
                            this.pushType({ kind: ReflectionKind.class, classType: Uint16Array, types: [] });
                            break;
                        case ReflectionOp.int16Array:
                            this.pushType({ kind: ReflectionKind.class, classType: Int16Array, types: [] });
                            break;
                        case ReflectionOp.uint32Array:
                            this.pushType({ kind: ReflectionKind.class, classType: Uint32Array, types: [] });
                            break;
                        case ReflectionOp.int32Array:
                            this.pushType({ kind: ReflectionKind.class, classType: Int32Array, types: [] });
                            break;
                        case ReflectionOp.float32Array:
                            this.pushType({ kind: ReflectionKind.class, classType: Float32Array, types: [] });
                            break;
                        case ReflectionOp.float64Array:
                            this.pushType({ kind: ReflectionKind.class, classType: Float64Array, types: [] });
                            break;
                        case ReflectionOp.bigInt64Array:
                            this.pushType({
                                kind: ReflectionKind.class,
                                classType: 'undefined' !== typeof BigInt64Array ? BigInt64Array : class BigInt64ArrayNotAvailable {
                                },
                                types: []
                            });
                            break;
                        case ReflectionOp.arrayBuffer:
                            this.pushType({ kind: ReflectionKind.class, classType: ArrayBuffer, types: [] });
                            break;
                        case ReflectionOp.class: {
                            const types = this.popFrame() as Type[];
                            for (const member of types) {
                                if (member.kind === ReflectionKind.method && member.name === 'constructor') {
                                    for (const parameter of member.parameters) {
                                        if (parameter.visibility !== undefined) {
                                            const property = {
                                                kind: ReflectionKind.property,
                                                name: parameter.name,
                                                visibility: parameter.visibility,
                                                default: parameter.default,
                                                type: parameter.type,
                                            } as TypeProperty;
                                            if (parameter.optional) property.optional = true;
                                            if (parameter.readonly) property.readonly = true;
                                            parameter.type.parent = property;
                                            types.push(property);
                                        }
                                    }
                                    break;
                                }
                                // if (member.kind === ReflectionKind.property) member.type = widenLiteral(member.type);
                            }
                            const args = program.frame.inputs.filter(isType);
                            let t = { kind: ReflectionKind.class, classType: Object, types } as TypeClass;

                            //only for the very last op do we replace this.resultType. Otherwise, objectLiteral in between would overwrite it.
                            if (this.isEnded()) t = Object.assign(program.resultType, t);

                            for (const member of t.types) member.parent = t;
                            if (t.arguments) for (const member of t.arguments) member.parent = t;
                            if (args.length) t.arguments = args;

                            if (this.isEnded()) {
                                t.typeArguments = program.typeParameters;
                            }

                            this.pushType(t);
                            break;
                        }
                        case ReflectionOp.widen: {
                            const current = (program.stack[program.stackPointer] as Type);
                            if (current.kind === ReflectionKind.literal) {
                                this.pushType(widenLiteral(this.pop() as TypeLiteral));
                            }
                            break;
                        }
                        case ReflectionOp.classExtends: {
                            const argsNumber = this.eatParameter() as number;
                            const typeArguments: Type[] = [];
                            for (let i = 0; i < argsNumber; i++) {
                                typeArguments.push(this.pop() as Type);
                            }

                            (program.stack[program.stackPointer] as TypeClass).extendsArguments = typeArguments;

                            break;
                        }
                        case ReflectionOp.parameter: {
                            const ref = this.eatParameter() as number;
                            const t: Type = { kind: ReflectionKind.parameter, parent: undefined as any, name: program.stack[ref] as string, type: this.pop() as OuterType };
                            t.type.parent = t;
                            this.pushType(t);
                            break;
                        }
                        case ReflectionOp.classReference: {
                            const ref = this.eatParameter() as number;
                            const classType = (program.stack[ref] as Function)();
                            const inputs = this.popFrame() as OuterType[];
                            if (!classType) throw new Error('No class reference given in ' + String(program.stack[ref]));

                            if (!classType.__type) {
                                this.pushType({ kind: ReflectionKind.class, classType, typeArguments: inputs, types: [] });
                            } else {

                                //when it's just a simple reference resolution like typeOf<Class>() then enable cache re-use (so always the same type is returned)
                                const reuseCached = !!(this.isEnded() && program.previous && program.previous.end === 0);

                                const result = this.reflect(classType, inputs, { reuseCached });
                                this.push(result, program);

                                if (isWithAnnotations(result) && inputs.length) {
                                    result.typeArguments = result.typeArguments || [];
                                    for (let i = 0; i < inputs.length; i++) {
                                        result.typeArguments[i] = inputs[i];
                                    }
                                }

                                //this.reflect/run might create another program onto the stack. switch to it if so
                                if (this.program !== program) {
                                    //continue to next this.program.
                                    program.program++; //manual increment as the for loop would normally do that
                                    continue programLoop;
                                }
                            }
                            break;
                        }
                        case ReflectionOp.enum: {
                            const types = this.popFrame() as TypeEnumMember[];
                            const enumType: { [name: string]: string | number } = {};

                            let i = 0;
                            for (const type of types) {
                                if (type.default) {
                                    const v = type.default();
                                    enumType[type.name] = v;
                                    if ('number' === typeof v) {
                                        i = v + 1;
                                    }
                                } else {
                                    enumType[type.name] = i++;
                                }
                            }
                            const t: Type = { kind: ReflectionKind.enum, enum: enumType, values: Object.values(enumType) };
                            this.pushType(t);
                            break;
                        }
                        case ReflectionOp.enumMember: {
                            const name = program.stack[this.eatParameter() as number] as string | (() => string);
                            this.pushType({
                                kind: ReflectionKind.enumMember,
                                parent: undefined as any,
                                name: isFunction(name) ? name() : name
                            });
                            break;
                        }
                        case ReflectionOp.tuple: {
                            this.handleTuple();
                            break;
                        }
                        case ReflectionOp.tupleMember: {
                            this.pushType({
                                kind: ReflectionKind.tupleMember, type: this.pop() as Type,
                                parent: undefined as any,
                            });
                            break;
                        }
                        case ReflectionOp.namedTupleMember: {
                            const name = program.stack[this.eatParameter() as number] as string;
                            const t: Type = {
                                kind: ReflectionKind.tupleMember, type: this.pop() as Type,
                                parent: undefined as any,
                                name: isFunction(name) ? name() : name
                            };
                            t.type.parent = t;
                            this.pushType(t);
                            break;
                        }
                        case ReflectionOp.rest: {
                            const t: Type = {
                                kind: ReflectionKind.rest,
                                parent: undefined as any,
                                type: this.pop() as Type,
                            };
                            t.type.parent = t;
                            this.pushType(t);
                            break;
                        }
                        case ReflectionOp.regexp: {
                            this.pushType({ kind: ReflectionKind.regexp });
                            break;
                        }
                        case ReflectionOp.typeParameter:
                        case ReflectionOp.typeParameterDefault: {
                            const nameRef = this.eatParameter() as number;
                            program.typeParameters = program.typeParameters || [];
                            let type = program.frame.inputs[program.frame.variables++];

                            if (op === ReflectionOp.typeParameterDefault) {
                                const defaultValue = this.pop();
                                if (type === undefined) {
                                    type = defaultValue;
                                }
                            }

                            if (type === undefined) {
                                //generic not instantiated
                                program.typeParameters.push({ kind: ReflectionKind.any });
                                this.pushType({ kind: ReflectionKind.typeParameter, name: program.stack[nameRef] as string });
                            } else {
                                program.typeParameters.push(type as OuterType);
                                this.pushType(type as Type);
                            }
                            break;
                        }
                        case ReflectionOp.set: {
                            const t: Type = { kind: ReflectionKind.class, classType: Set, arguments: [this.pop() as Type], types: [] };
                            t.arguments![0].parent = t;
                            this.pushType(t);
                            break;
                        }
                        case ReflectionOp.map: {
                            const value = this.pop() as Type;
                            const key = this.pop() as Type;
                            const t: TypeClass = { kind: ReflectionKind.class, classType: Map, arguments: [key, value], types: [] };
                            t.arguments![0].parent = t;
                            t.arguments![1].parent = t;
                            this.pushType(t);
                            break;
                        }
                        case ReflectionOp.promise: {
                            const t: Type = { kind: ReflectionKind.promise, type: this.pop() as OuterType };
                            t.type.parent = t;
                            this.pushType(t);
                            break;
                        }
                        case ReflectionOp.union: {
                            const types = this.popFrame() as Type[];
                            let t: Type = unboxUnion({ kind: ReflectionKind.union, types: flattenUnionTypes(types) });
                            if (this.isEnded()) t = Object.assign(program.resultType, t);
                            if (t.kind === ReflectionKind.union) for (const member of t.types) member.parent = t;
                            this.pushType(t);
                            break;
                        }
                        case ReflectionOp.intersection: {
                            this.handleIntersection();
                            break;
                        }
                        case ReflectionOp.function: {
                            const types = this.popFrame() as Type[];
                            const name = program.stack[this.eatParameter() as number] as string;
                            let t: TypeFunction = {
                                kind: ReflectionKind.function,
                                name: name || undefined,
                                return: types.length > 0 ? types[types.length - 1] as OuterType : { kind: ReflectionKind.any } as OuterType,
                                parameters: types.length > 1 ? types.slice(0, -1) as TypeParameter[] : []
                            };
                            if (this.isEnded()) t = Object.assign(program.resultType, t);
                            t.return.parent = t;
                            for (const member of t.parameters) member.parent = t;
                            this.pushType(t);
                            break;
                        }
                        case ReflectionOp.array: {
                            const t: Type = { kind: ReflectionKind.array, type: this.pop() as Type };
                            t.type.parent = t;
                            this.pushType(t);
                            break;
                        }
                        case ReflectionOp.property:
                        case ReflectionOp.propertySignature: {
                            const name = program.stack[this.eatParameter() as number] as number | string | symbol | (() => symbol);
                            let type = this.pop() as Type;
                            let isOptional = false;

                            if (type.kind === ReflectionKind.union && type.types.length === 2) {
                                const undefinedType = type.types.find(v => v.kind === ReflectionKind.undefined);
                                const restType = type.types.find(v => v.kind !== ReflectionKind.null && v.kind !== ReflectionKind.undefined);
                                if (restType && undefinedType) {
                                    type = restType;
                                    isOptional = true;
                                }
                            }

                            const property = {
                                kind: op === ReflectionOp.propertySignature ? ReflectionKind.propertySignature : ReflectionKind.property,
                                type,
                                name: isFunction(name) ? name() : name
                            } as TypeProperty | TypePropertySignature;

                            if (isOptional) {
                                property.optional = true;
                            }

                            if (op === ReflectionOp.property) {
                                (property as TypeProperty).visibility = ReflectionVisibility.public;
                            }

                            property.type.parent = property;
                            this.pushType(property);
                            break;
                        }
                        case ReflectionOp.method:
                        case ReflectionOp.methodSignature: {
                            const name = program.stack[this.eatParameter() as number] as number | string | symbol;
                            const types = this.popFrame() as Type[];
                            const returnType = types.length > 0 ? types[types.length - 1] as OuterType : { kind: ReflectionKind.any } as OuterType;
                            const parameters: TypeParameter[] = types.length > 1 ? types.slice(0, -1) as TypeParameter[] : [];

                            let t: TypeMethod | TypeMethodSignature = op === ReflectionOp.method
                                ? { kind: ReflectionKind.method, parent: undefined as any, visibility: ReflectionVisibility.public, name, return: returnType, parameters }
                                : { kind: ReflectionKind.methodSignature, parent: undefined as any, name, return: returnType, parameters };
                            if (this.isEnded()) t = Object.assign(program.resultType, t);
                            t.return.parent = t;
                            for (const member of t.parameters) member.parent = t;
                            this.pushType(t);
                            break;
                        }
                        case ReflectionOp.optional:
                            (program.stack[program.stackPointer] as TypeBaseMember | TypeTupleMember).optional = true;
                            break;
                        case ReflectionOp.readonly:
                            (program.stack[program.stackPointer] as TypeBaseMember).readonly = true;
                            break;
                        case ReflectionOp.public:
                            (program.stack[program.stackPointer] as TypeBaseMember).visibility = ReflectionVisibility.public;
                            break;
                        case ReflectionOp.protected:
                            (program.stack[program.stackPointer] as TypeBaseMember).visibility = ReflectionVisibility.protected;
                            break;
                        case ReflectionOp.private:
                            (program.stack[program.stackPointer] as TypeBaseMember).visibility = ReflectionVisibility.private;
                            break;
                        case ReflectionOp.abstract:
                            (program.stack[program.stackPointer] as TypeBaseMember).abstract = true;
                            break;
                        case ReflectionOp.defaultValue:
                            (program.stack[program.stackPointer] as TypeProperty | TypeEnumMember | TypeParameter).default = program.stack[this.eatParameter() as number] as () => any;
                            break;
                        case ReflectionOp.description:
                            (program.stack[program.stackPointer] as TypeProperty).description = program.stack[this.eatParameter() as number] as string;
                            break;
                        case ReflectionOp.indexSignature: {
                            const type = this.pop() as Type;
                            const index = this.pop() as Type;
                            const t: Type = { kind: ReflectionKind.indexSignature, parent: undefined as any, index, type };
                            t.type.parent = t;
                            t.index.parent = t;
                            this.pushType(t);
                            break;
                        }
                        case ReflectionOp.objectLiteral: {
                            let t = {
                                kind: ReflectionKind.objectLiteral,
                                types: []
                            } as TypeObjectLiteral;

                            const frameTypes = this.popFrame() as (TypeIndexSignature | TypePropertySignature | TypeMethodSignature | TypeObjectLiteral)[];
                            pushObjectLiteralTypes(t, frameTypes);

                            //only for the very last op do we replace this.resultType. Otherwise, objectLiteral in between would overwrite it.
                            if (this.isEnded()) t = Object.assign(program.resultType, t);
                            for (const member of t.types) member.parent = t;
                            this.pushType(t);
                            break;
                        }
                        // case ReflectionOp.pointer: {
                        //     this.push(program.stack[this.eatParameter() as number]);
                        //     break;
                        // }
                        case ReflectionOp.distribute: {
                            this.handleDistribute(program);
                            break;
                        }
                        case ReflectionOp.condition: {
                            const right = this.pop() as Type;
                            const left = this.pop() as Type;
                            const condition = this.pop() as Type | number;
                            this.popFrame();
                            isConditionTruthy(condition) ? this.pushType(left) : this.pushType(right);
                            break;
                        }
                        case ReflectionOp.jumpCondition: {
                            const leftProgram = this.eatParameter() as number;
                            const rightProgram = this.eatParameter() as number;
                            const condition = this.pop() as Type | number;
                            this.call(isConditionTruthy(condition) ? leftProgram : rightProgram);
                            break;
                        }
                        case ReflectionOp.infer: {
                            const frameOffset = this.eatParameter() as number;
                            const stackEntryIndex = this.eatParameter() as number;
                            const frame = program.frame;
                            this.push({
                                kind: ReflectionKind.infer, set: (type: Type) => {
                                    if (frameOffset === 0) {
                                        program.stack[frame.startIndex + 1 + stackEntryIndex] = type;
                                    } else if (frameOffset === 1) {
                                        program.stack[frame.previous!.startIndex + 1 + stackEntryIndex] = type;
                                    } else if (frameOffset === 2) {
                                        program.stack[frame.previous!.previous!.startIndex + 1 + stackEntryIndex] = type;
                                    } else if (frameOffset === 3) {
                                        program.stack[frame.previous!.previous!.previous!.startIndex + 1 + stackEntryIndex] = type;
                                    } else if (frameOffset === 4) {
                                        program.stack[frame.previous!.previous!.previous!.previous!.startIndex + 1 + stackEntryIndex] = type;
                                    } else {
                                        let current = frame;
                                        for (let i = 0; i < frameOffset; i++) current = current.previous!;
                                        program.stack[current.startIndex + 1 + stackEntryIndex] = type;
                                    }
                                }
                            } as TypeInfer);
                            break;
                        }
                        case ReflectionOp.extends: {
                            const right = this.pop() as string | number | boolean | Type;
                            const left = this.pop() as string | number | boolean | Type;
                            this.pushType({ kind: ReflectionKind.literal, literal: isExtendable(left, right) });
                            break;
                        }
                        case ReflectionOp.indexAccess: {
                            this.handleIndexAccess();
                            break;
                        }
                        case ReflectionOp.typeof: {
                            const param1 = this.eatParameter() as number;
                            const fn = program.stack[param1] as () => any;
                            const value = fn();

                            //typeInfer calls Processor.run() and changes this.program, so handle it correctly
                            const result = typeInfer(value);
                            this.push(result, program);

                            //this.reflect/run might create another program onto the stack. switch to it if so
                            if (this.program !== program) {
                                //continue to next this.program.
                                program.program++; //manual increment as the for loop would normally do that
                                continue programLoop;
                            }
                            break;
                        }
                        case ReflectionOp.keyof: {
                            this.handleKeyOf();
                            break;
                        }
                        case ReflectionOp.var: {
                            this.push({ kind: ReflectionKind.never });
                            program.frame.variables++;
                            break;
                        }
                        case ReflectionOp.mappedType: {
                            this.handleMappedType(program);
                            break;
                        }
                        case ReflectionOp.loads: {
                            const frameOffset = this.eatParameter() as number;
                            const stackEntryIndex = this.eatParameter() as number;
                            if (frameOffset === 0) {
                                this.push(program.stack[program.frame.startIndex + 1 + stackEntryIndex]);
                            } else if (frameOffset === 1) {
                                this.push(program.stack[program.frame.previous!.startIndex + 1 + stackEntryIndex]);
                            } else if (frameOffset === 2) {
                                this.push(program.stack[program.frame.previous!.previous!.startIndex + 1 + stackEntryIndex]);
                            } else if (frameOffset === 3) {
                                this.push(program.stack[program.frame.previous!.previous!.previous!.startIndex + 1 + stackEntryIndex]);
                            } else if (frameOffset === 4) {
                                this.push(program.stack[program.frame.previous!.previous!.previous!.previous!.startIndex + 1 + stackEntryIndex]);
                            } else {
                                let current = program.frame;
                                for (let i = 0; i < frameOffset; i++) current = current.previous!;
                                this.push(program.stack[current.startIndex + 1 + stackEntryIndex]);
                            }
                            break;
                        }
                        case ReflectionOp.arg: {
                            const arg = this.eatParameter() as number;
                            this.push(program.stack[program.frame.startIndex - arg]);
                            break;
                        }
                        case ReflectionOp.return: {
                            this.returnFrame();
                            break;
                        }
                        case ReflectionOp.frame: {
                            this.pushFrame();
                            break;
                        }
                        case ReflectionOp.moveFrame: {
                            const type = this.pop();
                            this.popFrame();
                            if (type) this.push(type);
                            break;
                        }
                        case ReflectionOp.jump: {
                            const arg = this.eatParameter() as number;
                            program.program = arg - 1; //-1 because next iteration does program++
                            break;
                        }
                        case ReflectionOp.call: {
                            const programPointer = this.eatParameter() as number;
                            this.call(programPointer);
                            break;
                        }
                        case ReflectionOp.inline: {
                            const pPosition = this.eatParameter() as number;
                            const pOrFn = program.stack[pPosition] as number | Packed | (() => Packed);
                            const p = isFunction(pOrFn) ? pOrFn() : pOrFn;
                            if ('number' === typeof p) {
                                //self circular reference, usually a 0, which indicates we put the result of the current program as the type on the stack.
                                this.push(program.resultType);
                            } else {
                                //when it's just a simple reference resolution like typeOf<Class>() then enable cache re-use (so always the same type is returned)
                                const reuseCached = !!(this.isEnded() && program.previous && program.previous.end === 0);
                                const result = this.reflect(p, [], { reuseCached });
                                if (isWithAnnotations(result)) {
                                    result.typeName = isFunction(pOrFn) ? pOrFn.toString().replace('() => __Ω', '') : '';
                                }
                                this.push(result, program);

                                //this.reflect/run might create another program onto the stack. switch to it if so
                                if (this.program !== program) {
                                    //continue to next this.program.
                                    program.program++; //manual increment as the for loop would normally do that
                                    continue programLoop;
                                }
                            }
                            break;
                        }
                        case ReflectionOp.inlineCall: {
                            const pPosition = this.eatParameter() as number;
                            const argumentSize = this.eatParameter() as number;
                            const inputs: OuterType[] = [];
                            for (let i = 0; i < argumentSize; i++) {
                                let input = this.pop() as OuterType;
                                if (input.kind === ReflectionKind.never && program.inputs[i]) input = program.inputs[i] as OuterType;
                                inputs.unshift(input);
                            }
                            const pOrFn = program.stack[pPosition] as number | Packed | (() => Packed);
                            const p = isFunction(pOrFn) ? pOrFn() : pOrFn;
                            if ('number' === typeof p) {
                                if (argumentSize === 0) {
                                    //self circular reference, usually a 0, which indicates we put the result of the current program as the type on the stack.
                                    this.push(program.resultType);
                                } else {
                                    //execute again the current program
                                    const nextProgram = createProgram({
                                        ops: program.ops,
                                        initialStack: program.initialStack,
                                    }, inputs);
                                    this.push(this.runProgram(nextProgram), program);

                                    //continue to next this.program that was assigned by runProgram()
                                    program.program++; //manual increment as the for loop would normally do that
                                    continue programLoop;
                                }
                            } else {
                                const result = this.reflect(p, inputs);

                                if (isWithAnnotations(result)) {
                                    result.typeName = isFunction(pOrFn) ? pOrFn.toString().replace('() => __Ω', '') : '';

                                    if (isWithAnnotations(result) && inputs.length) {
                                        result.typeArguments = result.typeArguments || [];
                                        for (let i = 0; i < inputs.length; i++) {
                                            result.typeArguments[i] = inputs[i];
                                        }
                                    }
                                }

                                this.push(result, program);

                                //this.reflect/run might create another program onto the stack. switch to it if so
                                if (this.program !== program) {
                                    //continue to next this.program.
                                    program.program++; //manual increment as the for loop would normally do that
                                    continue programLoop;
                                }
                            }
                            break;
                        }
                    }
                }

                result = narrowOriginalLiteral(program.stack[program.stackPointer] as Type);

                if (isType(result) && program.object) {
                    if (result.kind === ReflectionKind.class && result.classType === Object) {
                        result.classType = program.object;
                        //apply decorators
                        applyClassDecorators(result);
                    }
                    if (result.kind === ReflectionKind.function && !result.function) {
                        result.function = program.object;
                    }
                }

                if (program.previous) this.program = program.previous;
                if (program.resultType !== result) {
                    Object.assign(program.resultType, result);
                }
                if (program.resultTypes) for (const ref of program.resultTypes) {
                    Object.assign(ref, result);
                }
                if (until === program) return result;
            }

        return result;
    }

    private handleTuple() {
        const types: TypeTupleMember[] = [];
        const stackTypes = this.popFrame() as Type[];
        for (const type of stackTypes) {
            let resolved: TypeTupleMember = type.kind === ReflectionKind.tupleMember ? type : {
                kind: ReflectionKind.tupleMember,
                parent: undefined as any,
                type
            };
            if (resolved.type.kind === ReflectionKind.rest) {
                if (resolved.type.type.kind === ReflectionKind.tuple) {
                    for (const sub of resolved.type.type.types) {
                        types.push(sub);
                    }
                } else {
                    types.push(resolved);
                }
            } else {
                types.push(resolved);
            }
        }
        const t: Type = { kind: ReflectionKind.tuple, types };
        for (const member of t.types) member.parent = t;
        this.pushType(t);
    }

    private handleIntersection() {
        const types = this.popFrame() as Type[];
        let primitive = undefined as Type | undefined;
        const annotations: Annotations = {};
        const decorators: OuterType[] = [];
        const candidates: (TypeObjectLiteral | TypeClass)[] = [];

        function extractTypes(types: Type[]) {
            outer:
                for (const type of types) {
                    if (type.kind === ReflectionKind.never) continue;

                    if (type.kind === ReflectionKind.intersection) {
                        extractTypes(type.types);
                        continue;
                    }
                    if (type.kind === ReflectionKind.objectLiteral) {
                        for (const decorator of typeDecorators) {
                            if (decorator(annotations, type)) {
                                decorators.push(type);
                                continue outer;
                            }
                        }
                    }

                    if (!primitive && (isPrimitive(type) || type.kind === ReflectionKind.any || type.kind === ReflectionKind.array || type.kind === ReflectionKind.tuple || type.kind === ReflectionKind.regexp || type.kind === ReflectionKind.symbol)) {
                        //at the moment, we globally assume that people don't add types to array/tuple/regexp/symbols e.g. no `(string[] & {doSomething: () => void})`.
                        //we treat all additional types in the intersection as decorators.
                        primitive = type;
                    } else if (type.kind === ReflectionKind.objectLiteral || type.kind === ReflectionKind.class) {
                        candidates.push(type);
                    }
                }
        }

        extractTypes(types);

        let result = undefined as Type | undefined;

        if (primitive) {
            result = primitive;
            annotations[defaultAnnotation.symbol] = candidates;
        } else {
            if (candidates.length === 1) {
                result = candidates[0];
            } else {
                const isMergeAble = candidates.every(v => v.kind === ReflectionKind.objectLiteral || v.kind === ReflectionKind.class);
                if (isMergeAble) {
                    result = merge(candidates);
                } else {
                    result = candidates[0];
                }
            }
        }

        if (result) {
            if (isWithAnnotations(result)) {
                result.annotations = result.annotations || {};
                if (decorators.length) result.decorators = decorators;
                Object.assign(result.annotations, annotations);
            }
            this.pushType(result);
        } else {
            this.pushType({ kind: ReflectionKind.never });
        }
    }

    private handleDistribute(program: Program) {
        const programPointer = this.eatParameter() as number;

        if (program.frame.distributiveLoop) {
            const type = this.pop() as Type;

            if (type.kind === ReflectionKind.never) {
                //we ignore never, to filter them out
            } else {
                this.push(type);
            }
        } else {
            //start loop
            const distributeOver = this.pop() as Type;
            program.frame.distributiveLoop = new Loop(distributeOver);
        }

        const next = program.frame.distributiveLoop.next();
        if (next === undefined) {
            //end
            const types = this.popFrame() as Type[];
            const result: TypeUnion = { kind: ReflectionKind.union, types: flattenUnionTypes(types) };
            const t: Type = unboxUnion(result);
            if (t.kind === ReflectionKind.union) for (const member of t.types) member.parent = t;
            this.push(t);
        } else {
            program.stack[program.frame.startIndex + 1] = next;
            this.call(programPointer, -1); //-1=jump back to this very same position, to be able to loop
        }
    }

    private handleIndexAccess() {
        let right = this.pop() as Type;
        const left = this.pop() as Type;

        if (!isType(left)) {
            this.push({ kind: ReflectionKind.never });
        } else {

            const t: Type = indexAccess(left, right);
            if (isWithAnnotations(t)) {
                t.indexAccessOrigin = { container: left as TypeObjectLiteral, index: right as OuterType };
            }

            t.parent = undefined;
            this.push(t);
        }
    }

    private handleKeyOf() {
        const type = this.pop() as Type;
        const union = { kind: ReflectionKind.union, types: [] } as TypeUnion;
        this.push(union);
        if (type.kind === ReflectionKind.objectLiteral || type.kind === ReflectionKind.class) {
            for (const member of type.types) {
                if (member.kind === ReflectionKind.propertySignature || member.kind === ReflectionKind.property) {
                    union.types.push({ kind: ReflectionKind.literal, literal: member.name } as TypeLiteral);
                } else if (member.kind === ReflectionKind.methodSignature || member.kind === ReflectionKind.method) {
                    union.types.push({ kind: ReflectionKind.literal, literal: member.name } as TypeLiteral);
                }
            }
        }
    }

    private handleMappedType(program: Program) {
        const functionPointer = this.eatParameter() as number;
        const modifier = this.eatParameter() as number;

        if (program.frame.mappedType) {
            const type = this.pop() as Type;
            let index: Type | string | boolean | symbol | number | bigint = program.stack[program.frame.startIndex + 1] as Type;

            if (index.kind === ReflectionKind.string || index.kind === ReflectionKind.number || index.kind === ReflectionKind.symbol) {
                this.push({ kind: ReflectionKind.indexSignature, type, index });
            } else {
                if (index.kind === ReflectionKind.literal && !(index.literal instanceof RegExp)) {
                    index = index.literal;
                }

                const property: TypeProperty | TypePropertySignature = type.kind === ReflectionKind.propertySignature || type.kind === ReflectionKind.property
                    ? type
                    : { kind: ReflectionKind.propertySignature, name: index, type } as TypePropertySignature;

                if (property.type.kind !== ReflectionKind.never) {
                    //never is filtered out

                    if (modifier !== 0) {
                        if (modifier & MappedModifier.optional) {
                            property.optional = true;
                        }
                        if (modifier & MappedModifier.removeOptional && property.optional) {
                            property.optional = undefined;
                        }
                        if (modifier & MappedModifier.readonly) {
                            property.readonly = true;
                        }
                        if (modifier & MappedModifier.removeReadonly && property.readonly) {
                            property.readonly = undefined;
                        }
                    }
                    this.push(property);
                }
            }
        } else {
            program.frame.mappedType = new Loop(this.pop() as Type);
        }

        const next = program.frame.mappedType.next();
        if (next === undefined) {
            //end
            let t: TypeObjectLiteral = { kind: ReflectionKind.objectLiteral, types: this.popFrame() as any[] };
            if (this.isEnded()) t = Object.assign(program.resultType, t);

            for (const member of t.types) member.parent = t;
            this.push(t);
        } else {
            program.stack[program.frame.startIndex + 1] = next; //change the mapped type parameter
            this.call(functionPointer, -2);
        }
    }

    private handleTemplateLiteral() {
        const types = this.popFrame() as Type[];
        const result: TypeUnion = { kind: ReflectionKind.union, types: [] };
        // const templateLiteral: TypeTemplateLiteral = { kind: ReflectionKind.templateLiteral, types: [] };
        const cartesian = new CartesianProduct();
        for (const type of types) {
            cartesian.add(type);
        }
        const product = cartesian.calculate();

        for (const combination of product) {
            const template: TypeTemplateLiteral = { kind: ReflectionKind.templateLiteral, types: [] };
            let hasPlaceholder = false;
            let lastLiteral: { kind: ReflectionKind.literal, literal: string, parent?: Type } | undefined = undefined;
            //merge a combination of types, e.g. [string, 'abc', '3'] as template literal => `${string}abc3`.
            for (const item of combination) {
                if (item.kind === ReflectionKind.literal) {
                    if (lastLiteral) {
                        lastLiteral.literal += item.literal as string + '';
                    } else {
                        lastLiteral = { kind: ReflectionKind.literal, literal: item.literal as string + '', parent: template };
                        template.types.push(lastLiteral);
                    }
                } else {
                    hasPlaceholder = true;
                    lastLiteral = undefined;
                    item.parent = template;
                    template.types.push(item as TypeTemplateLiteral['types'][number]);
                }
            }

            if (hasPlaceholder) {
                if (template.types.length === 1 && template.types[0].kind === ReflectionKind.string) {
                    template.types[0].parent = result;
                    result.types.push(template.types[0]);
                } else {
                    template.parent = result;
                    result.types.push(template);
                }
            } else if (lastLiteral) {
                lastLiteral.parent = result;
                result.types.push(lastLiteral);
            }
        }
        const t: Type = unboxUnion(result);
        if (t.kind === ReflectionKind.union) for (const member of t.types) member.parent = t;
        this.pushType(t);
    }

    protected push(entry: RuntimeStackEntry, program: Program = this.program): void {
        const i = ++program.stackPointer;

        if (i < program.stack.length) {
            program.stack[i] = entry;
        } else {
            program.stack.push(entry);
        }
    }

    protected pop(): RuntimeStackEntry {
        if (this.program.stackPointer < 0) throw new Error('Stack empty');
        return this.program.stack[this.program.stackPointer--];
    }

    protected pushFrame(): void {
        this.program.frame = {
            index: this.program.frame.index + 1,
            startIndex: this.program.stackPointer,
            inputs: [],
            variables: 0,
            previous: this.program.frame,
        };
    }

    protected popFrame(): RuntimeStackEntry[] {
        const result = this.program.stack.slice(this.program.frame.startIndex + this.program.frame.variables + 1, this.program.stackPointer + 1);
        this.program.stackPointer = this.program.frame.startIndex;
        if (this.program.frame.previous) this.program.frame = this.program.frame.previous;
        return result;
    }

    /**
     * Create a new stack frame with the calling convention.
     */
    protected call(program: number, jumpBackTo: number = 1): void {
        this.push(this.program.program + jumpBackTo); //the `return address`
        this.pushFrame();
        // process.stdout.write(`[${this.program.frame.index}] call ${program}\n`);
        this.program.program = program - 1; //-1 because next iteration does program++
    }

    /**
     * Removes the stack frame, and puts the latest entry on the stack.
     */
    protected returnFrame(): void {
        const returnValue = this.pop(); //latest entry on the stack is the return value
        const returnAddress = this.program.stack[this.program.frame.startIndex]; //startIndex points the to new frame - 1 position, which is the `return address`.
        // process.stdout.write(`[${this.program.frame.index}] return ${returnAddress}\n`);
        this.program.stackPointer = this.program.frame.startIndex - 1; //-1 because call convention adds `return address` before entering new frame
        this.push(returnValue);
        if ('number' === typeof returnAddress) this.program.program = returnAddress - 1; //-1 because iteration does program++
        if (this.program.frame.previous) this.program.frame = this.program.frame.previous;
    }

    protected pushType(type: Type): void {
        this.push(type);
    }

    protected eatParameter(): RuntimeStackEntry {
        return this.program.ops[++this.program.program];
    }
}

function typeInferFromContainer(container: Iterable<any>): Type {
    const union: TypeUnion = { kind: ReflectionKind.union, types: [] };
    for (const item of container) {
        const type = widenLiteral(typeInfer(item));
        if (!isTypeIncluded(union.types, type)) union.types.push(type);
    }

    return union.types.length === 0 ? { kind: ReflectionKind.any } : union.types.length === 1 ? union.types[0] : union;
}

export function typeInfer(value: any): OuterType {
    if ('string' === typeof value || 'number' === typeof value || 'boolean' === typeof value || 'bigint' === typeof value || 'symbol' === typeof value) {
        return { kind: ReflectionKind.literal, literal: value };
    } else if (null === value) {
        return { kind: ReflectionKind.null };
    } else if (undefined === value) {
        return { kind: ReflectionKind.undefined };
    } else if (value instanceof RegExp) {
        return { kind: ReflectionKind.literal, literal: value };
    } else if ('function' === typeof value) {
        if (isArray(value.__type)) {
            //with emitted types: function or class
            return resolveRuntimeType(value);
        }

        if (isClass(value)) {
            //unknown class
            return { kind: ReflectionKind.class, classType: value, types: [] };
        }

        return { kind: ReflectionKind.function, name: value.name, return: { kind: ReflectionKind.any }, parameters: [] };
    } else if (isArray(value)) {
        return { kind: ReflectionKind.array, type: typeInferFromContainer(value) };
    } else if ('object' === typeof value) {
        const constructor = value.constructor;
        if ('function' === typeof constructor && constructor !== Object && isArray(constructor.__type)) {
            //with emitted types
            return resolveRuntimeType(constructor);
        }

        if (constructor === RegExp) return { kind: ReflectionKind.regexp };
        if (constructor === Date) return { kind: ReflectionKind.class, classType: Date, types: [] };
        if (constructor === Set) {
            const type = typeInferFromContainer(value);
            return { kind: ReflectionKind.class, classType: Set, arguments: [type], types: [] };
        }

        if (constructor === Map) {
            const keyType = typeInferFromContainer((value as Map<any, any>).keys());
            const valueType = typeInferFromContainer((value as Map<any, any>).values());
            return { kind: ReflectionKind.class, classType: Map, arguments: [keyType, valueType], types: [] };
        }

        //generate a new program that builds a objectLiteral. This is necessary since typeInfer() with its resolveRuntimeType calls might return immediately TypeAny if
        //the execution was scheduled (if we are in an executing program) so we can not depend on the result directly.
        //each part of the program of a value[i] is executed after the current OP, so we have to schedule new OPs doing the same as
        //in this loop here and construct the objectLiteral in the VM.
        const resultType: TypeObjectLiteral = { kind: ReflectionKind.objectLiteral, types: [] };
        const ops: ReflectionOp[] = [];
        const stack: RuntimeStackEntry[] = [];

        for (const i in value) {
            const indexTypeOfArg = stack.length;
            stack.push(() => value[i]);
            ops.push(ReflectionOp.typeof, indexTypeOfArg, ReflectionOp.widen);

            const indexName = stack.length;
            stack.push(i);
            ops.push(ReflectionOp.propertySignature, indexName);
        }

        ops.push(ReflectionOp.objectLiteral);

        return Processor.get().runProgram(createProgram({ ops, stack, resultType })) as OuterType;
    }
    return { kind: ReflectionKind.any };
}

function applyClassDecorators(type: TypeClass) {
    if (!isWithDeferredDecorators(type.classType)) return;

    for (const decorator of type.classType.__decorators) {
        const { data, property, parameterIndexOrDescriptor } = decorator;

        if (property !== undefined) {
            const member = getMember(type, property);
            if (!member) continue;

            if (member.kind === ReflectionKind.propertySignature || member.kind === ReflectionKind.property) {
                applyPropertyDecorator(member.type, data);
            }

            if ('number' === typeof parameterIndexOrDescriptor && (member.kind === ReflectionKind.method || member.kind === ReflectionKind.methodSignature)) {
                const param = member.parameters[parameterIndexOrDescriptor];
                if (param) {
                    applyPropertyDecorator(param.type, data);
                }
            }
        }
    }
}

function applyPropertyDecorator(type: OuterType, data: TData) {
    //map @t.validate to Validate<>
    if (data.validators.length && isWithAnnotations(type)) {
        const annotations = getAnnotations(type);
        for (const validator of data.validators) {
            validationAnnotation.register(annotations, {
                name: 'function',
                args: [{ kind: ReflectionKind.function, function: validator, parameters: [], return: { kind: ReflectionKind.any } }]
            });
        }
    }
}

function pushObjectLiteralTypes(
    type: TypeObjectLiteral,
    types: (TypeIndexSignature | TypePropertySignature | TypeMethodSignature | TypeObjectLiteral)[],
) {
    let annotations: Annotations = {};
    const decorators: OuterType[] = [];

    outer:
        for (const member of types) {
            if (member.kind === ReflectionKind.objectLiteral) {
                //all `extends T` expression land at the beginning of the stack frame, and are always an objectLiteral.
                //we use it as base and move its types first into types

                //it might be a decorator
                for (const decorator of typeDecorators) {
                    if (decorator(annotations, member)) {
                        decorators.push(member);
                        continue outer;
                    }
                }

                pushObjectLiteralTypes(type, member.types);

                //redirect decorators
                if (member.decorators) {
                    decorators.push(...member.decorators);
                }
                if (member.annotations) {
                    annotations = Object.assign(member.annotations, annotations);
                }
            } else if (member.kind === ReflectionKind.indexSignature) {
                //note: is it possible to overwrite an index signature?
                type.types.push(member);
            } else if (member.kind === ReflectionKind.propertySignature || member.kind === ReflectionKind.methodSignature) {
                const toAdd = member.kind === ReflectionKind.propertySignature && member.type.kind === ReflectionKind.function ? {
                    kind: ReflectionKind.methodSignature,
                    name: member.name,
                    optional: member.optional,
                    parameters: member.type.parameters,
                    return: member.type.return,
                } as TypeMethodSignature : member;

                const existing = type.types.findIndex(v => (v.kind === ReflectionKind.propertySignature || v.kind === ReflectionKind.methodSignature) && v.name === toAdd.name);
                if (existing !== -1) {
                    //remove entry, since we replace it
                    types.splice(existing, 1);
                }
                type.types.push(toAdd);
            }
        }

    type.annotations = type.annotations || {};
    if (decorators.length) type.decorators = decorators;

    Object.assign(type.annotations, annotations);
}