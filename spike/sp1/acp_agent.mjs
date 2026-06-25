var __defProp = Object.defineProperty;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};

// node_modules/zod/v3/external.js
var exports_external = {};
__export(exports_external, {
  void: () => voidType,
  util: () => util,
  unknown: () => unknownType,
  union: () => unionType,
  undefined: () => undefinedType,
  tuple: () => tupleType,
  transformer: () => effectsType,
  symbol: () => symbolType,
  string: () => stringType,
  strictObject: () => strictObjectType,
  setErrorMap: () => setErrorMap,
  set: () => setType,
  record: () => recordType,
  quotelessJson: () => quotelessJson,
  promise: () => promiseType,
  preprocess: () => preprocessType,
  pipeline: () => pipelineType,
  ostring: () => ostring,
  optional: () => optionalType,
  onumber: () => onumber,
  oboolean: () => oboolean,
  objectUtil: () => objectUtil,
  object: () => objectType,
  number: () => numberType,
  nullable: () => nullableType,
  null: () => nullType,
  never: () => neverType,
  nativeEnum: () => nativeEnumType,
  nan: () => nanType,
  map: () => mapType,
  makeIssue: () => makeIssue,
  literal: () => literalType,
  lazy: () => lazyType,
  late: () => late,
  isValid: () => isValid,
  isDirty: () => isDirty,
  isAsync: () => isAsync,
  isAborted: () => isAborted,
  intersection: () => intersectionType,
  instanceof: () => instanceOfType,
  getParsedType: () => getParsedType,
  getErrorMap: () => getErrorMap,
  function: () => functionType,
  enum: () => enumType,
  effect: () => effectsType,
  discriminatedUnion: () => discriminatedUnionType,
  defaultErrorMap: () => en_default,
  datetimeRegex: () => datetimeRegex,
  date: () => dateType,
  custom: () => custom,
  coerce: () => coerce,
  boolean: () => booleanType,
  bigint: () => bigIntType,
  array: () => arrayType,
  any: () => anyType,
  addIssueToContext: () => addIssueToContext,
  ZodVoid: () => ZodVoid,
  ZodUnknown: () => ZodUnknown,
  ZodUnion: () => ZodUnion,
  ZodUndefined: () => ZodUndefined,
  ZodType: () => ZodType,
  ZodTuple: () => ZodTuple,
  ZodTransformer: () => ZodEffects,
  ZodSymbol: () => ZodSymbol,
  ZodString: () => ZodString,
  ZodSet: () => ZodSet,
  ZodSchema: () => ZodType,
  ZodRecord: () => ZodRecord,
  ZodReadonly: () => ZodReadonly,
  ZodPromise: () => ZodPromise,
  ZodPipeline: () => ZodPipeline,
  ZodParsedType: () => ZodParsedType,
  ZodOptional: () => ZodOptional,
  ZodObject: () => ZodObject,
  ZodNumber: () => ZodNumber,
  ZodNullable: () => ZodNullable,
  ZodNull: () => ZodNull,
  ZodNever: () => ZodNever,
  ZodNativeEnum: () => ZodNativeEnum,
  ZodNaN: () => ZodNaN,
  ZodMap: () => ZodMap,
  ZodLiteral: () => ZodLiteral,
  ZodLazy: () => ZodLazy,
  ZodIssueCode: () => ZodIssueCode,
  ZodIntersection: () => ZodIntersection,
  ZodFunction: () => ZodFunction,
  ZodFirstPartyTypeKind: () => ZodFirstPartyTypeKind,
  ZodError: () => ZodError,
  ZodEnum: () => ZodEnum,
  ZodEffects: () => ZodEffects,
  ZodDiscriminatedUnion: () => ZodDiscriminatedUnion,
  ZodDefault: () => ZodDefault,
  ZodDate: () => ZodDate,
  ZodCatch: () => ZodCatch,
  ZodBranded: () => ZodBranded,
  ZodBoolean: () => ZodBoolean,
  ZodBigInt: () => ZodBigInt,
  ZodArray: () => ZodArray,
  ZodAny: () => ZodAny,
  Schema: () => ZodType,
  ParseStatus: () => ParseStatus,
  OK: () => OK,
  NEVER: () => NEVER,
  INVALID: () => INVALID,
  EMPTY_PATH: () => EMPTY_PATH,
  DIRTY: () => DIRTY,
  BRAND: () => BRAND
});

// node_modules/zod/v3/helpers/util.js
var util;
(function(util2) {
  util2.assertEqual = (_) => {};
  function assertIs(_arg) {}
  util2.assertIs = assertIs;
  function assertNever(_x) {
    throw new Error;
  }
  util2.assertNever = assertNever;
  util2.arrayToEnum = (items) => {
    const obj = {};
    for (const item of items) {
      obj[item] = item;
    }
    return obj;
  };
  util2.getValidEnumValues = (obj) => {
    const validKeys = util2.objectKeys(obj).filter((k) => typeof obj[obj[k]] !== "number");
    const filtered = {};
    for (const k of validKeys) {
      filtered[k] = obj[k];
    }
    return util2.objectValues(filtered);
  };
  util2.objectValues = (obj) => {
    return util2.objectKeys(obj).map(function(e) {
      return obj[e];
    });
  };
  util2.objectKeys = typeof Object.keys === "function" ? (obj) => Object.keys(obj) : (object) => {
    const keys = [];
    for (const key in object) {
      if (Object.prototype.hasOwnProperty.call(object, key)) {
        keys.push(key);
      }
    }
    return keys;
  };
  util2.find = (arr, checker) => {
    for (const item of arr) {
      if (checker(item))
        return item;
    }
    return;
  };
  util2.isInteger = typeof Number.isInteger === "function" ? (val) => Number.isInteger(val) : (val) => typeof val === "number" && Number.isFinite(val) && Math.floor(val) === val;
  function joinValues(array, separator = " | ") {
    return array.map((val) => typeof val === "string" ? `'${val}'` : val).join(separator);
  }
  util2.joinValues = joinValues;
  util2.jsonStringifyReplacer = (_, value) => {
    if (typeof value === "bigint") {
      return value.toString();
    }
    return value;
  };
})(util || (util = {}));
var objectUtil;
(function(objectUtil2) {
  objectUtil2.mergeShapes = (first, second) => {
    return {
      ...first,
      ...second
    };
  };
})(objectUtil || (objectUtil = {}));
var ZodParsedType = util.arrayToEnum([
  "string",
  "nan",
  "number",
  "integer",
  "float",
  "boolean",
  "date",
  "bigint",
  "symbol",
  "function",
  "undefined",
  "null",
  "array",
  "object",
  "unknown",
  "promise",
  "void",
  "never",
  "map",
  "set"
]);
var getParsedType = (data) => {
  const t = typeof data;
  switch (t) {
    case "undefined":
      return ZodParsedType.undefined;
    case "string":
      return ZodParsedType.string;
    case "number":
      return Number.isNaN(data) ? ZodParsedType.nan : ZodParsedType.number;
    case "boolean":
      return ZodParsedType.boolean;
    case "function":
      return ZodParsedType.function;
    case "bigint":
      return ZodParsedType.bigint;
    case "symbol":
      return ZodParsedType.symbol;
    case "object":
      if (Array.isArray(data)) {
        return ZodParsedType.array;
      }
      if (data === null) {
        return ZodParsedType.null;
      }
      if (data.then && typeof data.then === "function" && data.catch && typeof data.catch === "function") {
        return ZodParsedType.promise;
      }
      if (typeof Map !== "undefined" && data instanceof Map) {
        return ZodParsedType.map;
      }
      if (typeof Set !== "undefined" && data instanceof Set) {
        return ZodParsedType.set;
      }
      if (typeof Date !== "undefined" && data instanceof Date) {
        return ZodParsedType.date;
      }
      return ZodParsedType.object;
    default:
      return ZodParsedType.unknown;
  }
};

// node_modules/zod/v3/ZodError.js
var ZodIssueCode = util.arrayToEnum([
  "invalid_type",
  "invalid_literal",
  "custom",
  "invalid_union",
  "invalid_union_discriminator",
  "invalid_enum_value",
  "unrecognized_keys",
  "invalid_arguments",
  "invalid_return_type",
  "invalid_date",
  "invalid_string",
  "too_small",
  "too_big",
  "invalid_intersection_types",
  "not_multiple_of",
  "not_finite"
]);
var quotelessJson = (obj) => {
  const json = JSON.stringify(obj, null, 2);
  return json.replace(/"([^"]+)":/g, "$1:");
};

class ZodError extends Error {
  get errors() {
    return this.issues;
  }
  constructor(issues) {
    super();
    this.issues = [];
    this.addIssue = (sub) => {
      this.issues = [...this.issues, sub];
    };
    this.addIssues = (subs = []) => {
      this.issues = [...this.issues, ...subs];
    };
    const actualProto = new.target.prototype;
    if (Object.setPrototypeOf) {
      Object.setPrototypeOf(this, actualProto);
    } else {
      this.__proto__ = actualProto;
    }
    this.name = "ZodError";
    this.issues = issues;
  }
  format(_mapper) {
    const mapper = _mapper || function(issue) {
      return issue.message;
    };
    const fieldErrors = { _errors: [] };
    const processError = (error) => {
      for (const issue of error.issues) {
        if (issue.code === "invalid_union") {
          issue.unionErrors.map(processError);
        } else if (issue.code === "invalid_return_type") {
          processError(issue.returnTypeError);
        } else if (issue.code === "invalid_arguments") {
          processError(issue.argumentsError);
        } else if (issue.path.length === 0) {
          fieldErrors._errors.push(mapper(issue));
        } else {
          let curr = fieldErrors;
          let i = 0;
          while (i < issue.path.length) {
            const el = issue.path[i];
            const terminal = i === issue.path.length - 1;
            if (!terminal) {
              curr[el] = curr[el] || { _errors: [] };
            } else {
              curr[el] = curr[el] || { _errors: [] };
              curr[el]._errors.push(mapper(issue));
            }
            curr = curr[el];
            i++;
          }
        }
      }
    };
    processError(this);
    return fieldErrors;
  }
  static assert(value) {
    if (!(value instanceof ZodError)) {
      throw new Error(`Not a ZodError: ${value}`);
    }
  }
  toString() {
    return this.message;
  }
  get message() {
    return JSON.stringify(this.issues, util.jsonStringifyReplacer, 2);
  }
  get isEmpty() {
    return this.issues.length === 0;
  }
  flatten(mapper = (issue) => issue.message) {
    const fieldErrors = {};
    const formErrors = [];
    for (const sub of this.issues) {
      if (sub.path.length > 0) {
        const firstEl = sub.path[0];
        fieldErrors[firstEl] = fieldErrors[firstEl] || [];
        fieldErrors[firstEl].push(mapper(sub));
      } else {
        formErrors.push(mapper(sub));
      }
    }
    return { formErrors, fieldErrors };
  }
  get formErrors() {
    return this.flatten();
  }
}
ZodError.create = (issues) => {
  const error = new ZodError(issues);
  return error;
};

// node_modules/zod/v3/locales/en.js
var errorMap = (issue, _ctx) => {
  let message;
  switch (issue.code) {
    case ZodIssueCode.invalid_type:
      if (issue.received === ZodParsedType.undefined) {
        message = "Required";
      } else {
        message = `Expected ${issue.expected}, received ${issue.received}`;
      }
      break;
    case ZodIssueCode.invalid_literal:
      message = `Invalid literal value, expected ${JSON.stringify(issue.expected, util.jsonStringifyReplacer)}`;
      break;
    case ZodIssueCode.unrecognized_keys:
      message = `Unrecognized key(s) in object: ${util.joinValues(issue.keys, ", ")}`;
      break;
    case ZodIssueCode.invalid_union:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_union_discriminator:
      message = `Invalid discriminator value. Expected ${util.joinValues(issue.options)}`;
      break;
    case ZodIssueCode.invalid_enum_value:
      message = `Invalid enum value. Expected ${util.joinValues(issue.options)}, received '${issue.received}'`;
      break;
    case ZodIssueCode.invalid_arguments:
      message = `Invalid function arguments`;
      break;
    case ZodIssueCode.invalid_return_type:
      message = `Invalid function return type`;
      break;
    case ZodIssueCode.invalid_date:
      message = `Invalid date`;
      break;
    case ZodIssueCode.invalid_string:
      if (typeof issue.validation === "object") {
        if ("includes" in issue.validation) {
          message = `Invalid input: must include "${issue.validation.includes}"`;
          if (typeof issue.validation.position === "number") {
            message = `${message} at one or more positions greater than or equal to ${issue.validation.position}`;
          }
        } else if ("startsWith" in issue.validation) {
          message = `Invalid input: must start with "${issue.validation.startsWith}"`;
        } else if ("endsWith" in issue.validation) {
          message = `Invalid input: must end with "${issue.validation.endsWith}"`;
        } else {
          util.assertNever(issue.validation);
        }
      } else if (issue.validation !== "regex") {
        message = `Invalid ${issue.validation}`;
      } else {
        message = "Invalid";
      }
      break;
    case ZodIssueCode.too_small:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `more than`} ${issue.minimum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `over`} ${issue.minimum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === "bigint")
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${new Date(Number(issue.minimum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.too_big:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `less than`} ${issue.maximum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `under`} ${issue.maximum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "bigint")
        message = `BigInt must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly` : issue.inclusive ? `smaller than or equal to` : `smaller than`} ${new Date(Number(issue.maximum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.custom:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_intersection_types:
      message = `Intersection results could not be merged`;
      break;
    case ZodIssueCode.not_multiple_of:
      message = `Number must be a multiple of ${issue.multipleOf}`;
      break;
    case ZodIssueCode.not_finite:
      message = "Number must be finite";
      break;
    default:
      message = _ctx.defaultError;
      util.assertNever(issue);
  }
  return { message };
};
var en_default = errorMap;

// node_modules/zod/v3/errors.js
var overrideErrorMap = en_default;
function setErrorMap(map) {
  overrideErrorMap = map;
}
function getErrorMap() {
  return overrideErrorMap;
}
// node_modules/zod/v3/helpers/parseUtil.js
var makeIssue = (params) => {
  const { data, path, errorMaps, issueData } = params;
  const fullPath = [...path, ...issueData.path || []];
  const fullIssue = {
    ...issueData,
    path: fullPath
  };
  if (issueData.message !== undefined) {
    return {
      ...issueData,
      path: fullPath,
      message: issueData.message
    };
  }
  let errorMessage = "";
  const maps = errorMaps.filter((m) => !!m).slice().reverse();
  for (const map of maps) {
    errorMessage = map(fullIssue, { data, defaultError: errorMessage }).message;
  }
  return {
    ...issueData,
    path: fullPath,
    message: errorMessage
  };
};
var EMPTY_PATH = [];
function addIssueToContext(ctx, issueData) {
  const overrideMap = getErrorMap();
  const issue = makeIssue({
    issueData,
    data: ctx.data,
    path: ctx.path,
    errorMaps: [
      ctx.common.contextualErrorMap,
      ctx.schemaErrorMap,
      overrideMap,
      overrideMap === en_default ? undefined : en_default
    ].filter((x) => !!x)
  });
  ctx.common.issues.push(issue);
}

class ParseStatus {
  constructor() {
    this.value = "valid";
  }
  dirty() {
    if (this.value === "valid")
      this.value = "dirty";
  }
  abort() {
    if (this.value !== "aborted")
      this.value = "aborted";
  }
  static mergeArray(status, results) {
    const arrayValue = [];
    for (const s of results) {
      if (s.status === "aborted")
        return INVALID;
      if (s.status === "dirty")
        status.dirty();
      arrayValue.push(s.value);
    }
    return { status: status.value, value: arrayValue };
  }
  static async mergeObjectAsync(status, pairs) {
    const syncPairs = [];
    for (const pair of pairs) {
      const key = await pair.key;
      const value = await pair.value;
      syncPairs.push({
        key,
        value
      });
    }
    return ParseStatus.mergeObjectSync(status, syncPairs);
  }
  static mergeObjectSync(status, pairs) {
    const finalObject = {};
    for (const pair of pairs) {
      const { key, value } = pair;
      if (key.status === "aborted")
        return INVALID;
      if (value.status === "aborted")
        return INVALID;
      if (key.status === "dirty")
        status.dirty();
      if (value.status === "dirty")
        status.dirty();
      if (key.value !== "__proto__" && (typeof value.value !== "undefined" || pair.alwaysSet)) {
        finalObject[key.value] = value.value;
      }
    }
    return { status: status.value, value: finalObject };
  }
}
var INVALID = Object.freeze({
  status: "aborted"
});
var DIRTY = (value) => ({ status: "dirty", value });
var OK = (value) => ({ status: "valid", value });
var isAborted = (x) => x.status === "aborted";
var isDirty = (x) => x.status === "dirty";
var isValid = (x) => x.status === "valid";
var isAsync = (x) => typeof Promise !== "undefined" && x instanceof Promise;
// node_modules/zod/v3/helpers/errorUtil.js
var errorUtil;
(function(errorUtil2) {
  errorUtil2.errToObj = (message) => typeof message === "string" ? { message } : message || {};
  errorUtil2.toString = (message) => typeof message === "string" ? message : message?.message;
})(errorUtil || (errorUtil = {}));

// node_modules/zod/v3/types.js
class ParseInputLazyPath {
  constructor(parent, value, path, key) {
    this._cachedPath = [];
    this.parent = parent;
    this.data = value;
    this._path = path;
    this._key = key;
  }
  get path() {
    if (!this._cachedPath.length) {
      if (Array.isArray(this._key)) {
        this._cachedPath.push(...this._path, ...this._key);
      } else {
        this._cachedPath.push(...this._path, this._key);
      }
    }
    return this._cachedPath;
  }
}
var handleResult = (ctx, result) => {
  if (isValid(result)) {
    return { success: true, data: result.value };
  } else {
    if (!ctx.common.issues.length) {
      throw new Error("Validation failed but no issues detected.");
    }
    return {
      success: false,
      get error() {
        if (this._error)
          return this._error;
        const error = new ZodError(ctx.common.issues);
        this._error = error;
        return this._error;
      }
    };
  }
};
function processCreateParams(params) {
  if (!params)
    return {};
  const { errorMap: errorMap2, invalid_type_error, required_error, description } = params;
  if (errorMap2 && (invalid_type_error || required_error)) {
    throw new Error(`Can't use "invalid_type_error" or "required_error" in conjunction with custom error map.`);
  }
  if (errorMap2)
    return { errorMap: errorMap2, description };
  const customMap = (iss, ctx) => {
    const { message } = params;
    if (iss.code === "invalid_enum_value") {
      return { message: message ?? ctx.defaultError };
    }
    if (typeof ctx.data === "undefined") {
      return { message: message ?? required_error ?? ctx.defaultError };
    }
    if (iss.code !== "invalid_type")
      return { message: ctx.defaultError };
    return { message: message ?? invalid_type_error ?? ctx.defaultError };
  };
  return { errorMap: customMap, description };
}

class ZodType {
  get description() {
    return this._def.description;
  }
  _getType(input) {
    return getParsedType(input.data);
  }
  _getOrReturnCtx(input, ctx) {
    return ctx || {
      common: input.parent.common,
      data: input.data,
      parsedType: getParsedType(input.data),
      schemaErrorMap: this._def.errorMap,
      path: input.path,
      parent: input.parent
    };
  }
  _processInputParams(input) {
    return {
      status: new ParseStatus,
      ctx: {
        common: input.parent.common,
        data: input.data,
        parsedType: getParsedType(input.data),
        schemaErrorMap: this._def.errorMap,
        path: input.path,
        parent: input.parent
      }
    };
  }
  _parseSync(input) {
    const result = this._parse(input);
    if (isAsync(result)) {
      throw new Error("Synchronous parse encountered promise.");
    }
    return result;
  }
  _parseAsync(input) {
    const result = this._parse(input);
    return Promise.resolve(result);
  }
  parse(data, params) {
    const result = this.safeParse(data, params);
    if (result.success)
      return result.data;
    throw result.error;
  }
  safeParse(data, params) {
    const ctx = {
      common: {
        issues: [],
        async: params?.async ?? false,
        contextualErrorMap: params?.errorMap
      },
      path: params?.path || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const result = this._parseSync({ data, path: ctx.path, parent: ctx });
    return handleResult(ctx, result);
  }
  "~validate"(data) {
    const ctx = {
      common: {
        issues: [],
        async: !!this["~standard"].async
      },
      path: [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    if (!this["~standard"].async) {
      try {
        const result = this._parseSync({ data, path: [], parent: ctx });
        return isValid(result) ? {
          value: result.value
        } : {
          issues: ctx.common.issues
        };
      } catch (err) {
        if (err?.message?.toLowerCase()?.includes("encountered")) {
          this["~standard"].async = true;
        }
        ctx.common = {
          issues: [],
          async: true
        };
      }
    }
    return this._parseAsync({ data, path: [], parent: ctx }).then((result) => isValid(result) ? {
      value: result.value
    } : {
      issues: ctx.common.issues
    });
  }
  async parseAsync(data, params) {
    const result = await this.safeParseAsync(data, params);
    if (result.success)
      return result.data;
    throw result.error;
  }
  async safeParseAsync(data, params) {
    const ctx = {
      common: {
        issues: [],
        contextualErrorMap: params?.errorMap,
        async: true
      },
      path: params?.path || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const maybeAsyncResult = this._parse({ data, path: ctx.path, parent: ctx });
    const result = await (isAsync(maybeAsyncResult) ? maybeAsyncResult : Promise.resolve(maybeAsyncResult));
    return handleResult(ctx, result);
  }
  refine(check, message) {
    const getIssueProperties = (val) => {
      if (typeof message === "string" || typeof message === "undefined") {
        return { message };
      } else if (typeof message === "function") {
        return message(val);
      } else {
        return message;
      }
    };
    return this._refinement((val, ctx) => {
      const result = check(val);
      const setError = () => ctx.addIssue({
        code: ZodIssueCode.custom,
        ...getIssueProperties(val)
      });
      if (typeof Promise !== "undefined" && result instanceof Promise) {
        return result.then((data) => {
          if (!data) {
            setError();
            return false;
          } else {
            return true;
          }
        });
      }
      if (!result) {
        setError();
        return false;
      } else {
        return true;
      }
    });
  }
  refinement(check, refinementData) {
    return this._refinement((val, ctx) => {
      if (!check(val)) {
        ctx.addIssue(typeof refinementData === "function" ? refinementData(val, ctx) : refinementData);
        return false;
      } else {
        return true;
      }
    });
  }
  _refinement(refinement) {
    return new ZodEffects({
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "refinement", refinement }
    });
  }
  superRefine(refinement) {
    return this._refinement(refinement);
  }
  constructor(def) {
    this.spa = this.safeParseAsync;
    this._def = def;
    this.parse = this.parse.bind(this);
    this.safeParse = this.safeParse.bind(this);
    this.parseAsync = this.parseAsync.bind(this);
    this.safeParseAsync = this.safeParseAsync.bind(this);
    this.spa = this.spa.bind(this);
    this.refine = this.refine.bind(this);
    this.refinement = this.refinement.bind(this);
    this.superRefine = this.superRefine.bind(this);
    this.optional = this.optional.bind(this);
    this.nullable = this.nullable.bind(this);
    this.nullish = this.nullish.bind(this);
    this.array = this.array.bind(this);
    this.promise = this.promise.bind(this);
    this.or = this.or.bind(this);
    this.and = this.and.bind(this);
    this.transform = this.transform.bind(this);
    this.brand = this.brand.bind(this);
    this.default = this.default.bind(this);
    this.catch = this.catch.bind(this);
    this.describe = this.describe.bind(this);
    this.pipe = this.pipe.bind(this);
    this.readonly = this.readonly.bind(this);
    this.isNullable = this.isNullable.bind(this);
    this.isOptional = this.isOptional.bind(this);
    this["~standard"] = {
      version: 1,
      vendor: "zod",
      validate: (data) => this["~validate"](data)
    };
  }
  optional() {
    return ZodOptional.create(this, this._def);
  }
  nullable() {
    return ZodNullable.create(this, this._def);
  }
  nullish() {
    return this.nullable().optional();
  }
  array() {
    return ZodArray.create(this);
  }
  promise() {
    return ZodPromise.create(this, this._def);
  }
  or(option) {
    return ZodUnion.create([this, option], this._def);
  }
  and(incoming) {
    return ZodIntersection.create(this, incoming, this._def);
  }
  transform(transform) {
    return new ZodEffects({
      ...processCreateParams(this._def),
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "transform", transform }
    });
  }
  default(def) {
    const defaultValueFunc = typeof def === "function" ? def : () => def;
    return new ZodDefault({
      ...processCreateParams(this._def),
      innerType: this,
      defaultValue: defaultValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodDefault
    });
  }
  brand() {
    return new ZodBranded({
      typeName: ZodFirstPartyTypeKind.ZodBranded,
      type: this,
      ...processCreateParams(this._def)
    });
  }
  catch(def) {
    const catchValueFunc = typeof def === "function" ? def : () => def;
    return new ZodCatch({
      ...processCreateParams(this._def),
      innerType: this,
      catchValue: catchValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodCatch
    });
  }
  describe(description) {
    const This = this.constructor;
    return new This({
      ...this._def,
      description
    });
  }
  pipe(target) {
    return ZodPipeline.create(this, target);
  }
  readonly() {
    return ZodReadonly.create(this);
  }
  isOptional() {
    return this.safeParse(undefined).success;
  }
  isNullable() {
    return this.safeParse(null).success;
  }
}
var cuidRegex = /^c[^\s-]{8,}$/i;
var cuid2Regex = /^[0-9a-z]+$/;
var ulidRegex = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
var uuidRegex = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i;
var nanoidRegex = /^[a-z0-9_-]{21}$/i;
var jwtRegex = /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/;
var durationRegex = /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/;
var emailRegex = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i;
var _emojiRegex = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
var emojiRegex;
var ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
var ipv4CidrRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/(3[0-2]|[12]?[0-9])$/;
var ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;
var ipv6CidrRegex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
var base64Regex = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/;
var base64urlRegex = /^([0-9a-zA-Z-_]{4})*(([0-9a-zA-Z-_]{2}(==)?)|([0-9a-zA-Z-_]{3}(=)?))?$/;
var dateRegexSource = `((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))`;
var dateRegex = new RegExp(`^${dateRegexSource}$`);
function timeRegexSource(args) {
  let secondsRegexSource = `[0-5]\\d`;
  if (args.precision) {
    secondsRegexSource = `${secondsRegexSource}\\.\\d{${args.precision}}`;
  } else if (args.precision == null) {
    secondsRegexSource = `${secondsRegexSource}(\\.\\d+)?`;
  }
  const secondsQuantifier = args.precision ? "+" : "?";
  return `([01]\\d|2[0-3]):[0-5]\\d(:${secondsRegexSource})${secondsQuantifier}`;
}
function timeRegex(args) {
  return new RegExp(`^${timeRegexSource(args)}$`);
}
function datetimeRegex(args) {
  let regex = `${dateRegexSource}T${timeRegexSource(args)}`;
  const opts = [];
  opts.push(args.local ? `Z?` : `Z`);
  if (args.offset)
    opts.push(`([+-]\\d{2}:?\\d{2})`);
  regex = `${regex}(${opts.join("|")})`;
  return new RegExp(`^${regex}$`);
}
function isValidIP(ip, version) {
  if ((version === "v4" || !version) && ipv4Regex.test(ip)) {
    return true;
  }
  if ((version === "v6" || !version) && ipv6Regex.test(ip)) {
    return true;
  }
  return false;
}
function isValidJWT(jwt, alg) {
  if (!jwtRegex.test(jwt))
    return false;
  try {
    const [header] = jwt.split(".");
    if (!header)
      return false;
    const base64 = header.replace(/-/g, "+").replace(/_/g, "/").padEnd(header.length + (4 - header.length % 4) % 4, "=");
    const decoded = JSON.parse(atob(base64));
    if (typeof decoded !== "object" || decoded === null)
      return false;
    if ("typ" in decoded && decoded?.typ !== "JWT")
      return false;
    if (!decoded.alg)
      return false;
    if (alg && decoded.alg !== alg)
      return false;
    return true;
  } catch {
    return false;
  }
}
function isValidCidr(ip, version) {
  if ((version === "v4" || !version) && ipv4CidrRegex.test(ip)) {
    return true;
  }
  if ((version === "v6" || !version) && ipv6CidrRegex.test(ip)) {
    return true;
  }
  return false;
}

class ZodString extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = String(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.string) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.string,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const status = new ParseStatus;
    let ctx = undefined;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.length < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.length > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "length") {
        const tooBig = input.data.length > check.value;
        const tooSmall = input.data.length < check.value;
        if (tooBig || tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          if (tooBig) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_big,
              maximum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          } else if (tooSmall) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_small,
              minimum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          }
          status.dirty();
        }
      } else if (check.kind === "email") {
        if (!emailRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "email",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "emoji") {
        if (!emojiRegex) {
          emojiRegex = new RegExp(_emojiRegex, "u");
        }
        if (!emojiRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "emoji",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "uuid") {
        if (!uuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "uuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "nanoid") {
        if (!nanoidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "nanoid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cuid") {
        if (!cuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cuid2") {
        if (!cuid2Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid2",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "ulid") {
        if (!ulidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ulid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "url") {
        try {
          new URL(input.data);
        } catch {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "regex") {
        check.regex.lastIndex = 0;
        const testResult = check.regex.test(input.data);
        if (!testResult) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "regex",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "trim") {
        input.data = input.data.trim();
      } else if (check.kind === "includes") {
        if (!input.data.includes(check.value, check.position)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { includes: check.value, position: check.position },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "toLowerCase") {
        input.data = input.data.toLowerCase();
      } else if (check.kind === "toUpperCase") {
        input.data = input.data.toUpperCase();
      } else if (check.kind === "startsWith") {
        if (!input.data.startsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { startsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "endsWith") {
        if (!input.data.endsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { endsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "datetime") {
        const regex = datetimeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "datetime",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "date") {
        const regex = dateRegex;
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "date",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "time") {
        const regex = timeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "time",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "duration") {
        if (!durationRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "duration",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "ip") {
        if (!isValidIP(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ip",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "jwt") {
        if (!isValidJWT(input.data, check.alg)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "jwt",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cidr") {
        if (!isValidCidr(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cidr",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "base64") {
        if (!base64Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "base64url") {
        if (!base64urlRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _regex(regex, validation, message) {
    return this.refinement((data) => regex.test(data), {
      validation,
      code: ZodIssueCode.invalid_string,
      ...errorUtil.errToObj(message)
    });
  }
  _addCheck(check) {
    return new ZodString({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  email(message) {
    return this._addCheck({ kind: "email", ...errorUtil.errToObj(message) });
  }
  url(message) {
    return this._addCheck({ kind: "url", ...errorUtil.errToObj(message) });
  }
  emoji(message) {
    return this._addCheck({ kind: "emoji", ...errorUtil.errToObj(message) });
  }
  uuid(message) {
    return this._addCheck({ kind: "uuid", ...errorUtil.errToObj(message) });
  }
  nanoid(message) {
    return this._addCheck({ kind: "nanoid", ...errorUtil.errToObj(message) });
  }
  cuid(message) {
    return this._addCheck({ kind: "cuid", ...errorUtil.errToObj(message) });
  }
  cuid2(message) {
    return this._addCheck({ kind: "cuid2", ...errorUtil.errToObj(message) });
  }
  ulid(message) {
    return this._addCheck({ kind: "ulid", ...errorUtil.errToObj(message) });
  }
  base64(message) {
    return this._addCheck({ kind: "base64", ...errorUtil.errToObj(message) });
  }
  base64url(message) {
    return this._addCheck({
      kind: "base64url",
      ...errorUtil.errToObj(message)
    });
  }
  jwt(options) {
    return this._addCheck({ kind: "jwt", ...errorUtil.errToObj(options) });
  }
  ip(options) {
    return this._addCheck({ kind: "ip", ...errorUtil.errToObj(options) });
  }
  cidr(options) {
    return this._addCheck({ kind: "cidr", ...errorUtil.errToObj(options) });
  }
  datetime(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "datetime",
        precision: null,
        offset: false,
        local: false,
        message: options
      });
    }
    return this._addCheck({
      kind: "datetime",
      precision: typeof options?.precision === "undefined" ? null : options?.precision,
      offset: options?.offset ?? false,
      local: options?.local ?? false,
      ...errorUtil.errToObj(options?.message)
    });
  }
  date(message) {
    return this._addCheck({ kind: "date", message });
  }
  time(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "time",
        precision: null,
        message: options
      });
    }
    return this._addCheck({
      kind: "time",
      precision: typeof options?.precision === "undefined" ? null : options?.precision,
      ...errorUtil.errToObj(options?.message)
    });
  }
  duration(message) {
    return this._addCheck({ kind: "duration", ...errorUtil.errToObj(message) });
  }
  regex(regex, message) {
    return this._addCheck({
      kind: "regex",
      regex,
      ...errorUtil.errToObj(message)
    });
  }
  includes(value, options) {
    return this._addCheck({
      kind: "includes",
      value,
      position: options?.position,
      ...errorUtil.errToObj(options?.message)
    });
  }
  startsWith(value, message) {
    return this._addCheck({
      kind: "startsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  endsWith(value, message) {
    return this._addCheck({
      kind: "endsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  min(minLength, message) {
    return this._addCheck({
      kind: "min",
      value: minLength,
      ...errorUtil.errToObj(message)
    });
  }
  max(maxLength, message) {
    return this._addCheck({
      kind: "max",
      value: maxLength,
      ...errorUtil.errToObj(message)
    });
  }
  length(len, message) {
    return this._addCheck({
      kind: "length",
      value: len,
      ...errorUtil.errToObj(message)
    });
  }
  nonempty(message) {
    return this.min(1, errorUtil.errToObj(message));
  }
  trim() {
    return new ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "trim" }]
    });
  }
  toLowerCase() {
    return new ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toLowerCase" }]
    });
  }
  toUpperCase() {
    return new ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toUpperCase" }]
    });
  }
  get isDatetime() {
    return !!this._def.checks.find((ch) => ch.kind === "datetime");
  }
  get isDate() {
    return !!this._def.checks.find((ch) => ch.kind === "date");
  }
  get isTime() {
    return !!this._def.checks.find((ch) => ch.kind === "time");
  }
  get isDuration() {
    return !!this._def.checks.find((ch) => ch.kind === "duration");
  }
  get isEmail() {
    return !!this._def.checks.find((ch) => ch.kind === "email");
  }
  get isURL() {
    return !!this._def.checks.find((ch) => ch.kind === "url");
  }
  get isEmoji() {
    return !!this._def.checks.find((ch) => ch.kind === "emoji");
  }
  get isUUID() {
    return !!this._def.checks.find((ch) => ch.kind === "uuid");
  }
  get isNANOID() {
    return !!this._def.checks.find((ch) => ch.kind === "nanoid");
  }
  get isCUID() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid");
  }
  get isCUID2() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid2");
  }
  get isULID() {
    return !!this._def.checks.find((ch) => ch.kind === "ulid");
  }
  get isIP() {
    return !!this._def.checks.find((ch) => ch.kind === "ip");
  }
  get isCIDR() {
    return !!this._def.checks.find((ch) => ch.kind === "cidr");
  }
  get isBase64() {
    return !!this._def.checks.find((ch) => ch.kind === "base64");
  }
  get isBase64url() {
    return !!this._def.checks.find((ch) => ch.kind === "base64url");
  }
  get minLength() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxLength() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
}
ZodString.create = (params) => {
  return new ZodString({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodString,
    coerce: params?.coerce ?? false,
    ...processCreateParams(params)
  });
};
function floatSafeRemainder(val, step) {
  const valDecCount = (val.toString().split(".")[1] || "").length;
  const stepDecCount = (step.toString().split(".")[1] || "").length;
  const decCount = valDecCount > stepDecCount ? valDecCount : stepDecCount;
  const valInt = Number.parseInt(val.toFixed(decCount).replace(".", ""));
  const stepInt = Number.parseInt(step.toFixed(decCount).replace(".", ""));
  return valInt % stepInt / 10 ** decCount;
}

class ZodNumber extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
    this.step = this.multipleOf;
  }
  _parse(input) {
    if (this._def.coerce) {
      input.data = Number(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.number) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.number,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    let ctx = undefined;
    const status = new ParseStatus;
    for (const check of this._def.checks) {
      if (check.kind === "int") {
        if (!util.isInteger(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_type,
            expected: "integer",
            received: "float",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (floatSafeRemainder(input.data, check.value) !== 0) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "finite") {
        if (!Number.isFinite(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_finite,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new ZodNumber({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new ZodNumber({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  int(message) {
    return this._addCheck({
      kind: "int",
      message: errorUtil.toString(message)
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  finite(message) {
    return this._addCheck({
      kind: "finite",
      message: errorUtil.toString(message)
    });
  }
  safe(message) {
    return this._addCheck({
      kind: "min",
      inclusive: true,
      value: Number.MIN_SAFE_INTEGER,
      message: errorUtil.toString(message)
    })._addCheck({
      kind: "max",
      inclusive: true,
      value: Number.MAX_SAFE_INTEGER,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
  get isInt() {
    return !!this._def.checks.find((ch) => ch.kind === "int" || ch.kind === "multipleOf" && util.isInteger(ch.value));
  }
  get isFinite() {
    let max = null;
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "finite" || ch.kind === "int" || ch.kind === "multipleOf") {
        return true;
      } else if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      } else if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return Number.isFinite(min) && Number.isFinite(max);
  }
}
ZodNumber.create = (params) => {
  return new ZodNumber({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodNumber,
    coerce: params?.coerce || false,
    ...processCreateParams(params)
  });
};

class ZodBigInt extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
  }
  _parse(input) {
    if (this._def.coerce) {
      try {
        input.data = BigInt(input.data);
      } catch {
        return this._getInvalidInput(input);
      }
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.bigint) {
      return this._getInvalidInput(input);
    }
    let ctx = undefined;
    const status = new ParseStatus;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            type: "bigint",
            minimum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            type: "bigint",
            maximum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (input.data % check.value !== BigInt(0)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _getInvalidInput(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.bigint,
      received: ctx.parsedType
    });
    return INVALID;
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new ZodBigInt({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new ZodBigInt({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
}
ZodBigInt.create = (params) => {
  return new ZodBigInt({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodBigInt,
    coerce: params?.coerce ?? false,
    ...processCreateParams(params)
  });
};

class ZodBoolean extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = Boolean(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.boolean) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.boolean,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
}
ZodBoolean.create = (params) => {
  return new ZodBoolean({
    typeName: ZodFirstPartyTypeKind.ZodBoolean,
    coerce: params?.coerce || false,
    ...processCreateParams(params)
  });
};

class ZodDate extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = new Date(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.date) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.date,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    if (Number.isNaN(input.data.getTime())) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_date
      });
      return INVALID;
    }
    const status = new ParseStatus;
    let ctx = undefined;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.getTime() < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            message: check.message,
            inclusive: true,
            exact: false,
            minimum: check.value,
            type: "date"
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.getTime() > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            message: check.message,
            inclusive: true,
            exact: false,
            maximum: check.value,
            type: "date"
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return {
      status: status.value,
      value: new Date(input.data.getTime())
    };
  }
  _addCheck(check) {
    return new ZodDate({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  min(minDate, message) {
    return this._addCheck({
      kind: "min",
      value: minDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  max(maxDate, message) {
    return this._addCheck({
      kind: "max",
      value: maxDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  get minDate() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min != null ? new Date(min) : null;
  }
  get maxDate() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max != null ? new Date(max) : null;
  }
}
ZodDate.create = (params) => {
  return new ZodDate({
    checks: [],
    coerce: params?.coerce || false,
    typeName: ZodFirstPartyTypeKind.ZodDate,
    ...processCreateParams(params)
  });
};

class ZodSymbol extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.symbol) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.symbol,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
}
ZodSymbol.create = (params) => {
  return new ZodSymbol({
    typeName: ZodFirstPartyTypeKind.ZodSymbol,
    ...processCreateParams(params)
  });
};

class ZodUndefined extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.undefined,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
}
ZodUndefined.create = (params) => {
  return new ZodUndefined({
    typeName: ZodFirstPartyTypeKind.ZodUndefined,
    ...processCreateParams(params)
  });
};

class ZodNull extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.null) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.null,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
}
ZodNull.create = (params) => {
  return new ZodNull({
    typeName: ZodFirstPartyTypeKind.ZodNull,
    ...processCreateParams(params)
  });
};

class ZodAny extends ZodType {
  constructor() {
    super(...arguments);
    this._any = true;
  }
  _parse(input) {
    return OK(input.data);
  }
}
ZodAny.create = (params) => {
  return new ZodAny({
    typeName: ZodFirstPartyTypeKind.ZodAny,
    ...processCreateParams(params)
  });
};

class ZodUnknown extends ZodType {
  constructor() {
    super(...arguments);
    this._unknown = true;
  }
  _parse(input) {
    return OK(input.data);
  }
}
ZodUnknown.create = (params) => {
  return new ZodUnknown({
    typeName: ZodFirstPartyTypeKind.ZodUnknown,
    ...processCreateParams(params)
  });
};

class ZodNever extends ZodType {
  _parse(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.never,
      received: ctx.parsedType
    });
    return INVALID;
  }
}
ZodNever.create = (params) => {
  return new ZodNever({
    typeName: ZodFirstPartyTypeKind.ZodNever,
    ...processCreateParams(params)
  });
};

class ZodVoid extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.void,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
}
ZodVoid.create = (params) => {
  return new ZodVoid({
    typeName: ZodFirstPartyTypeKind.ZodVoid,
    ...processCreateParams(params)
  });
};

class ZodArray extends ZodType {
  _parse(input) {
    const { ctx, status } = this._processInputParams(input);
    const def = this._def;
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (def.exactLength !== null) {
      const tooBig = ctx.data.length > def.exactLength.value;
      const tooSmall = ctx.data.length < def.exactLength.value;
      if (tooBig || tooSmall) {
        addIssueToContext(ctx, {
          code: tooBig ? ZodIssueCode.too_big : ZodIssueCode.too_small,
          minimum: tooSmall ? def.exactLength.value : undefined,
          maximum: tooBig ? def.exactLength.value : undefined,
          type: "array",
          inclusive: true,
          exact: true,
          message: def.exactLength.message
        });
        status.dirty();
      }
    }
    if (def.minLength !== null) {
      if (ctx.data.length < def.minLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.minLength.message
        });
        status.dirty();
      }
    }
    if (def.maxLength !== null) {
      if (ctx.data.length > def.maxLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.maxLength.message
        });
        status.dirty();
      }
    }
    if (ctx.common.async) {
      return Promise.all([...ctx.data].map((item, i) => {
        return def.type._parseAsync(new ParseInputLazyPath(ctx, item, ctx.path, i));
      })).then((result2) => {
        return ParseStatus.mergeArray(status, result2);
      });
    }
    const result = [...ctx.data].map((item, i) => {
      return def.type._parseSync(new ParseInputLazyPath(ctx, item, ctx.path, i));
    });
    return ParseStatus.mergeArray(status, result);
  }
  get element() {
    return this._def.type;
  }
  min(minLength, message) {
    return new ZodArray({
      ...this._def,
      minLength: { value: minLength, message: errorUtil.toString(message) }
    });
  }
  max(maxLength, message) {
    return new ZodArray({
      ...this._def,
      maxLength: { value: maxLength, message: errorUtil.toString(message) }
    });
  }
  length(len, message) {
    return new ZodArray({
      ...this._def,
      exactLength: { value: len, message: errorUtil.toString(message) }
    });
  }
  nonempty(message) {
    return this.min(1, message);
  }
}
ZodArray.create = (schema, params) => {
  return new ZodArray({
    type: schema,
    minLength: null,
    maxLength: null,
    exactLength: null,
    typeName: ZodFirstPartyTypeKind.ZodArray,
    ...processCreateParams(params)
  });
};
function deepPartialify(schema) {
  if (schema instanceof ZodObject) {
    const newShape = {};
    for (const key in schema.shape) {
      const fieldSchema = schema.shape[key];
      newShape[key] = ZodOptional.create(deepPartialify(fieldSchema));
    }
    return new ZodObject({
      ...schema._def,
      shape: () => newShape
    });
  } else if (schema instanceof ZodArray) {
    return new ZodArray({
      ...schema._def,
      type: deepPartialify(schema.element)
    });
  } else if (schema instanceof ZodOptional) {
    return ZodOptional.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodNullable) {
    return ZodNullable.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodTuple) {
    return ZodTuple.create(schema.items.map((item) => deepPartialify(item)));
  } else {
    return schema;
  }
}

class ZodObject extends ZodType {
  constructor() {
    super(...arguments);
    this._cached = null;
    this.nonstrict = this.passthrough;
    this.augment = this.extend;
  }
  _getCached() {
    if (this._cached !== null)
      return this._cached;
    const shape = this._def.shape();
    const keys = util.objectKeys(shape);
    this._cached = { shape, keys };
    return this._cached;
  }
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.object) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const { status, ctx } = this._processInputParams(input);
    const { shape, keys: shapeKeys } = this._getCached();
    const extraKeys = [];
    if (!(this._def.catchall instanceof ZodNever && this._def.unknownKeys === "strip")) {
      for (const key in ctx.data) {
        if (!shapeKeys.includes(key)) {
          extraKeys.push(key);
        }
      }
    }
    const pairs = [];
    for (const key of shapeKeys) {
      const keyValidator = shape[key];
      const value = ctx.data[key];
      pairs.push({
        key: { status: "valid", value: key },
        value: keyValidator._parse(new ParseInputLazyPath(ctx, value, ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (this._def.catchall instanceof ZodNever) {
      const unknownKeys = this._def.unknownKeys;
      if (unknownKeys === "passthrough") {
        for (const key of extraKeys) {
          pairs.push({
            key: { status: "valid", value: key },
            value: { status: "valid", value: ctx.data[key] }
          });
        }
      } else if (unknownKeys === "strict") {
        if (extraKeys.length > 0) {
          addIssueToContext(ctx, {
            code: ZodIssueCode.unrecognized_keys,
            keys: extraKeys
          });
          status.dirty();
        }
      } else if (unknownKeys === "strip") {} else {
        throw new Error(`Internal ZodObject error: invalid unknownKeys value.`);
      }
    } else {
      const catchall = this._def.catchall;
      for (const key of extraKeys) {
        const value = ctx.data[key];
        pairs.push({
          key: { status: "valid", value: key },
          value: catchall._parse(new ParseInputLazyPath(ctx, value, ctx.path, key)),
          alwaysSet: key in ctx.data
        });
      }
    }
    if (ctx.common.async) {
      return Promise.resolve().then(async () => {
        const syncPairs = [];
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          syncPairs.push({
            key,
            value,
            alwaysSet: pair.alwaysSet
          });
        }
        return syncPairs;
      }).then((syncPairs) => {
        return ParseStatus.mergeObjectSync(status, syncPairs);
      });
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get shape() {
    return this._def.shape();
  }
  strict(message) {
    errorUtil.errToObj;
    return new ZodObject({
      ...this._def,
      unknownKeys: "strict",
      ...message !== undefined ? {
        errorMap: (issue, ctx) => {
          const defaultError = this._def.errorMap?.(issue, ctx).message ?? ctx.defaultError;
          if (issue.code === "unrecognized_keys")
            return {
              message: errorUtil.errToObj(message).message ?? defaultError
            };
          return {
            message: defaultError
          };
        }
      } : {}
    });
  }
  strip() {
    return new ZodObject({
      ...this._def,
      unknownKeys: "strip"
    });
  }
  passthrough() {
    return new ZodObject({
      ...this._def,
      unknownKeys: "passthrough"
    });
  }
  extend(augmentation) {
    return new ZodObject({
      ...this._def,
      shape: () => ({
        ...this._def.shape(),
        ...augmentation
      })
    });
  }
  merge(merging) {
    const merged = new ZodObject({
      unknownKeys: merging._def.unknownKeys,
      catchall: merging._def.catchall,
      shape: () => ({
        ...this._def.shape(),
        ...merging._def.shape()
      }),
      typeName: ZodFirstPartyTypeKind.ZodObject
    });
    return merged;
  }
  setKey(key, schema) {
    return this.augment({ [key]: schema });
  }
  catchall(index) {
    return new ZodObject({
      ...this._def,
      catchall: index
    });
  }
  pick(mask) {
    const shape = {};
    for (const key of util.objectKeys(mask)) {
      if (mask[key] && this.shape[key]) {
        shape[key] = this.shape[key];
      }
    }
    return new ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  omit(mask) {
    const shape = {};
    for (const key of util.objectKeys(this.shape)) {
      if (!mask[key]) {
        shape[key] = this.shape[key];
      }
    }
    return new ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  deepPartial() {
    return deepPartialify(this);
  }
  partial(mask) {
    const newShape = {};
    for (const key of util.objectKeys(this.shape)) {
      const fieldSchema = this.shape[key];
      if (mask && !mask[key]) {
        newShape[key] = fieldSchema;
      } else {
        newShape[key] = fieldSchema.optional();
      }
    }
    return new ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  required(mask) {
    const newShape = {};
    for (const key of util.objectKeys(this.shape)) {
      if (mask && !mask[key]) {
        newShape[key] = this.shape[key];
      } else {
        const fieldSchema = this.shape[key];
        let newField = fieldSchema;
        while (newField instanceof ZodOptional) {
          newField = newField._def.innerType;
        }
        newShape[key] = newField;
      }
    }
    return new ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  keyof() {
    return createZodEnum(util.objectKeys(this.shape));
  }
}
ZodObject.create = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.strictCreate = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strict",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.lazycreate = (shape, params) => {
  return new ZodObject({
    shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};

class ZodUnion extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const options = this._def.options;
    function handleResults(results) {
      for (const result of results) {
        if (result.result.status === "valid") {
          return result.result;
        }
      }
      for (const result of results) {
        if (result.result.status === "dirty") {
          ctx.common.issues.push(...result.ctx.common.issues);
          return result.result;
        }
      }
      const unionErrors = results.map((result) => new ZodError(result.ctx.common.issues));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return Promise.all(options.map(async (option) => {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        return {
          result: await option._parseAsync({
            data: ctx.data,
            path: ctx.path,
            parent: childCtx
          }),
          ctx: childCtx
        };
      })).then(handleResults);
    } else {
      let dirty = undefined;
      const issues = [];
      for (const option of options) {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        const result = option._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: childCtx
        });
        if (result.status === "valid") {
          return result;
        } else if (result.status === "dirty" && !dirty) {
          dirty = { result, ctx: childCtx };
        }
        if (childCtx.common.issues.length) {
          issues.push(childCtx.common.issues);
        }
      }
      if (dirty) {
        ctx.common.issues.push(...dirty.ctx.common.issues);
        return dirty.result;
      }
      const unionErrors = issues.map((issues2) => new ZodError(issues2));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
  }
  get options() {
    return this._def.options;
  }
}
ZodUnion.create = (types, params) => {
  return new ZodUnion({
    options: types,
    typeName: ZodFirstPartyTypeKind.ZodUnion,
    ...processCreateParams(params)
  });
};
var getDiscriminator = (type) => {
  if (type instanceof ZodLazy) {
    return getDiscriminator(type.schema);
  } else if (type instanceof ZodEffects) {
    return getDiscriminator(type.innerType());
  } else if (type instanceof ZodLiteral) {
    return [type.value];
  } else if (type instanceof ZodEnum) {
    return type.options;
  } else if (type instanceof ZodNativeEnum) {
    return util.objectValues(type.enum);
  } else if (type instanceof ZodDefault) {
    return getDiscriminator(type._def.innerType);
  } else if (type instanceof ZodUndefined) {
    return [undefined];
  } else if (type instanceof ZodNull) {
    return [null];
  } else if (type instanceof ZodOptional) {
    return [undefined, ...getDiscriminator(type.unwrap())];
  } else if (type instanceof ZodNullable) {
    return [null, ...getDiscriminator(type.unwrap())];
  } else if (type instanceof ZodBranded) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodReadonly) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodCatch) {
    return getDiscriminator(type._def.innerType);
  } else {
    return [];
  }
};

class ZodDiscriminatedUnion extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const discriminator = this.discriminator;
    const discriminatorValue = ctx.data[discriminator];
    const option = this.optionsMap.get(discriminatorValue);
    if (!option) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union_discriminator,
        options: Array.from(this.optionsMap.keys()),
        path: [discriminator]
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return option._parseAsync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    } else {
      return option._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    }
  }
  get discriminator() {
    return this._def.discriminator;
  }
  get options() {
    return this._def.options;
  }
  get optionsMap() {
    return this._def.optionsMap;
  }
  static create(discriminator, options, params) {
    const optionsMap = new Map;
    for (const type of options) {
      const discriminatorValues = getDiscriminator(type.shape[discriminator]);
      if (!discriminatorValues.length) {
        throw new Error(`A discriminator value for key \`${discriminator}\` could not be extracted from all schema options`);
      }
      for (const value of discriminatorValues) {
        if (optionsMap.has(value)) {
          throw new Error(`Discriminator property ${String(discriminator)} has duplicate value ${String(value)}`);
        }
        optionsMap.set(value, type);
      }
    }
    return new ZodDiscriminatedUnion({
      typeName: ZodFirstPartyTypeKind.ZodDiscriminatedUnion,
      discriminator,
      options,
      optionsMap,
      ...processCreateParams(params)
    });
  }
}
function mergeValues(a, b) {
  const aType = getParsedType(a);
  const bType = getParsedType(b);
  if (a === b) {
    return { valid: true, data: a };
  } else if (aType === ZodParsedType.object && bType === ZodParsedType.object) {
    const bKeys = util.objectKeys(b);
    const sharedKeys = util.objectKeys(a).filter((key) => bKeys.indexOf(key) !== -1);
    const newObj = { ...a, ...b };
    for (const key of sharedKeys) {
      const sharedValue = mergeValues(a[key], b[key]);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newObj[key] = sharedValue.data;
    }
    return { valid: true, data: newObj };
  } else if (aType === ZodParsedType.array && bType === ZodParsedType.array) {
    if (a.length !== b.length) {
      return { valid: false };
    }
    const newArray = [];
    for (let index = 0;index < a.length; index++) {
      const itemA = a[index];
      const itemB = b[index];
      const sharedValue = mergeValues(itemA, itemB);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newArray.push(sharedValue.data);
    }
    return { valid: true, data: newArray };
  } else if (aType === ZodParsedType.date && bType === ZodParsedType.date && +a === +b) {
    return { valid: true, data: a };
  } else {
    return { valid: false };
  }
}

class ZodIntersection extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const handleParsed = (parsedLeft, parsedRight) => {
      if (isAborted(parsedLeft) || isAborted(parsedRight)) {
        return INVALID;
      }
      const merged = mergeValues(parsedLeft.value, parsedRight.value);
      if (!merged.valid) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_intersection_types
        });
        return INVALID;
      }
      if (isDirty(parsedLeft) || isDirty(parsedRight)) {
        status.dirty();
      }
      return { status: status.value, value: merged.data };
    };
    if (ctx.common.async) {
      return Promise.all([
        this._def.left._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        }),
        this._def.right._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        })
      ]).then(([left, right]) => handleParsed(left, right));
    } else {
      return handleParsed(this._def.left._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }), this._def.right._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }));
    }
  }
}
ZodIntersection.create = (left, right, params) => {
  return new ZodIntersection({
    left,
    right,
    typeName: ZodFirstPartyTypeKind.ZodIntersection,
    ...processCreateParams(params)
  });
};

class ZodTuple extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (ctx.data.length < this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_small,
        minimum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      return INVALID;
    }
    const rest = this._def.rest;
    if (!rest && ctx.data.length > this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_big,
        maximum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      status.dirty();
    }
    const items = [...ctx.data].map((item, itemIndex) => {
      const schema = this._def.items[itemIndex] || this._def.rest;
      if (!schema)
        return null;
      return schema._parse(new ParseInputLazyPath(ctx, item, ctx.path, itemIndex));
    }).filter((x) => !!x);
    if (ctx.common.async) {
      return Promise.all(items).then((results) => {
        return ParseStatus.mergeArray(status, results);
      });
    } else {
      return ParseStatus.mergeArray(status, items);
    }
  }
  get items() {
    return this._def.items;
  }
  rest(rest) {
    return new ZodTuple({
      ...this._def,
      rest
    });
  }
}
ZodTuple.create = (schemas, params) => {
  if (!Array.isArray(schemas)) {
    throw new Error("You must pass an array of schemas to z.tuple([ ... ])");
  }
  return new ZodTuple({
    items: schemas,
    typeName: ZodFirstPartyTypeKind.ZodTuple,
    rest: null,
    ...processCreateParams(params)
  });
};

class ZodRecord extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const pairs = [];
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    for (const key in ctx.data) {
      pairs.push({
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, key)),
        value: valueType._parse(new ParseInputLazyPath(ctx, ctx.data[key], ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (ctx.common.async) {
      return ParseStatus.mergeObjectAsync(status, pairs);
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get element() {
    return this._def.valueType;
  }
  static create(first, second, third) {
    if (second instanceof ZodType) {
      return new ZodRecord({
        keyType: first,
        valueType: second,
        typeName: ZodFirstPartyTypeKind.ZodRecord,
        ...processCreateParams(third)
      });
    }
    return new ZodRecord({
      keyType: ZodString.create(),
      valueType: first,
      typeName: ZodFirstPartyTypeKind.ZodRecord,
      ...processCreateParams(second)
    });
  }
}

class ZodMap extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.map) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.map,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    const pairs = [...ctx.data.entries()].map(([key, value], index) => {
      return {
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, [index, "key"])),
        value: valueType._parse(new ParseInputLazyPath(ctx, value, ctx.path, [index, "value"]))
      };
    });
    if (ctx.common.async) {
      const finalMap = new Map;
      return Promise.resolve().then(async () => {
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          if (key.status === "aborted" || value.status === "aborted") {
            return INVALID;
          }
          if (key.status === "dirty" || value.status === "dirty") {
            status.dirty();
          }
          finalMap.set(key.value, value.value);
        }
        return { status: status.value, value: finalMap };
      });
    } else {
      const finalMap = new Map;
      for (const pair of pairs) {
        const key = pair.key;
        const value = pair.value;
        if (key.status === "aborted" || value.status === "aborted") {
          return INVALID;
        }
        if (key.status === "dirty" || value.status === "dirty") {
          status.dirty();
        }
        finalMap.set(key.value, value.value);
      }
      return { status: status.value, value: finalMap };
    }
  }
}
ZodMap.create = (keyType, valueType, params) => {
  return new ZodMap({
    valueType,
    keyType,
    typeName: ZodFirstPartyTypeKind.ZodMap,
    ...processCreateParams(params)
  });
};

class ZodSet extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.set) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.set,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const def = this._def;
    if (def.minSize !== null) {
      if (ctx.data.size < def.minSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.minSize.message
        });
        status.dirty();
      }
    }
    if (def.maxSize !== null) {
      if (ctx.data.size > def.maxSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.maxSize.message
        });
        status.dirty();
      }
    }
    const valueType = this._def.valueType;
    function finalizeSet(elements2) {
      const parsedSet = new Set;
      for (const element of elements2) {
        if (element.status === "aborted")
          return INVALID;
        if (element.status === "dirty")
          status.dirty();
        parsedSet.add(element.value);
      }
      return { status: status.value, value: parsedSet };
    }
    const elements = [...ctx.data.values()].map((item, i) => valueType._parse(new ParseInputLazyPath(ctx, item, ctx.path, i)));
    if (ctx.common.async) {
      return Promise.all(elements).then((elements2) => finalizeSet(elements2));
    } else {
      return finalizeSet(elements);
    }
  }
  min(minSize, message) {
    return new ZodSet({
      ...this._def,
      minSize: { value: minSize, message: errorUtil.toString(message) }
    });
  }
  max(maxSize, message) {
    return new ZodSet({
      ...this._def,
      maxSize: { value: maxSize, message: errorUtil.toString(message) }
    });
  }
  size(size, message) {
    return this.min(size, message).max(size, message);
  }
  nonempty(message) {
    return this.min(1, message);
  }
}
ZodSet.create = (valueType, params) => {
  return new ZodSet({
    valueType,
    minSize: null,
    maxSize: null,
    typeName: ZodFirstPartyTypeKind.ZodSet,
    ...processCreateParams(params)
  });
};

class ZodFunction extends ZodType {
  constructor() {
    super(...arguments);
    this.validate = this.implement;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.function) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.function,
        received: ctx.parsedType
      });
      return INVALID;
    }
    function makeArgsIssue(args, error) {
      return makeIssue({
        data: args,
        path: ctx.path,
        errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, getErrorMap(), en_default].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode.invalid_arguments,
          argumentsError: error
        }
      });
    }
    function makeReturnsIssue(returns, error) {
      return makeIssue({
        data: returns,
        path: ctx.path,
        errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, getErrorMap(), en_default].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode.invalid_return_type,
          returnTypeError: error
        }
      });
    }
    const params = { errorMap: ctx.common.contextualErrorMap };
    const fn = ctx.data;
    if (this._def.returns instanceof ZodPromise) {
      const me = this;
      return OK(async function(...args) {
        const error = new ZodError([]);
        const parsedArgs = await me._def.args.parseAsync(args, params).catch((e) => {
          error.addIssue(makeArgsIssue(args, e));
          throw error;
        });
        const result = await Reflect.apply(fn, this, parsedArgs);
        const parsedReturns = await me._def.returns._def.type.parseAsync(result, params).catch((e) => {
          error.addIssue(makeReturnsIssue(result, e));
          throw error;
        });
        return parsedReturns;
      });
    } else {
      const me = this;
      return OK(function(...args) {
        const parsedArgs = me._def.args.safeParse(args, params);
        if (!parsedArgs.success) {
          throw new ZodError([makeArgsIssue(args, parsedArgs.error)]);
        }
        const result = Reflect.apply(fn, this, parsedArgs.data);
        const parsedReturns = me._def.returns.safeParse(result, params);
        if (!parsedReturns.success) {
          throw new ZodError([makeReturnsIssue(result, parsedReturns.error)]);
        }
        return parsedReturns.data;
      });
    }
  }
  parameters() {
    return this._def.args;
  }
  returnType() {
    return this._def.returns;
  }
  args(...items) {
    return new ZodFunction({
      ...this._def,
      args: ZodTuple.create(items).rest(ZodUnknown.create())
    });
  }
  returns(returnType) {
    return new ZodFunction({
      ...this._def,
      returns: returnType
    });
  }
  implement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  strictImplement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  static create(args, returns, params) {
    return new ZodFunction({
      args: args ? args : ZodTuple.create([]).rest(ZodUnknown.create()),
      returns: returns || ZodUnknown.create(),
      typeName: ZodFirstPartyTypeKind.ZodFunction,
      ...processCreateParams(params)
    });
  }
}

class ZodLazy extends ZodType {
  get schema() {
    return this._def.getter();
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const lazySchema = this._def.getter();
    return lazySchema._parse({ data: ctx.data, path: ctx.path, parent: ctx });
  }
}
ZodLazy.create = (getter, params) => {
  return new ZodLazy({
    getter,
    typeName: ZodFirstPartyTypeKind.ZodLazy,
    ...processCreateParams(params)
  });
};

class ZodLiteral extends ZodType {
  _parse(input) {
    if (input.data !== this._def.value) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_literal,
        expected: this._def.value
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
  get value() {
    return this._def.value;
  }
}
ZodLiteral.create = (value, params) => {
  return new ZodLiteral({
    value,
    typeName: ZodFirstPartyTypeKind.ZodLiteral,
    ...processCreateParams(params)
  });
};
function createZodEnum(values, params) {
  return new ZodEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodEnum,
    ...processCreateParams(params)
  });
}

class ZodEnum extends ZodType {
  _parse(input) {
    if (typeof input.data !== "string") {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(this._def.values);
    }
    if (!this._cache.has(input.data)) {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get options() {
    return this._def.values;
  }
  get enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Values() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  extract(values, newDef = this._def) {
    return ZodEnum.create(values, {
      ...this._def,
      ...newDef
    });
  }
  exclude(values, newDef = this._def) {
    return ZodEnum.create(this.options.filter((opt) => !values.includes(opt)), {
      ...this._def,
      ...newDef
    });
  }
}
ZodEnum.create = createZodEnum;

class ZodNativeEnum extends ZodType {
  _parse(input) {
    const nativeEnumValues = util.getValidEnumValues(this._def.values);
    const ctx = this._getOrReturnCtx(input);
    if (ctx.parsedType !== ZodParsedType.string && ctx.parsedType !== ZodParsedType.number) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(util.getValidEnumValues(this._def.values));
    }
    if (!this._cache.has(input.data)) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get enum() {
    return this._def.values;
  }
}
ZodNativeEnum.create = (values, params) => {
  return new ZodNativeEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodNativeEnum,
    ...processCreateParams(params)
  });
};

class ZodPromise extends ZodType {
  unwrap() {
    return this._def.type;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.promise && ctx.common.async === false) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.promise,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const promisified = ctx.parsedType === ZodParsedType.promise ? ctx.data : Promise.resolve(ctx.data);
    return OK(promisified.then((data) => {
      return this._def.type.parseAsync(data, {
        path: ctx.path,
        errorMap: ctx.common.contextualErrorMap
      });
    }));
  }
}
ZodPromise.create = (schema, params) => {
  return new ZodPromise({
    type: schema,
    typeName: ZodFirstPartyTypeKind.ZodPromise,
    ...processCreateParams(params)
  });
};

class ZodEffects extends ZodType {
  innerType() {
    return this._def.schema;
  }
  sourceType() {
    return this._def.schema._def.typeName === ZodFirstPartyTypeKind.ZodEffects ? this._def.schema.sourceType() : this._def.schema;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const effect = this._def.effect || null;
    const checkCtx = {
      addIssue: (arg) => {
        addIssueToContext(ctx, arg);
        if (arg.fatal) {
          status.abort();
        } else {
          status.dirty();
        }
      },
      get path() {
        return ctx.path;
      }
    };
    checkCtx.addIssue = checkCtx.addIssue.bind(checkCtx);
    if (effect.type === "preprocess") {
      const processed = effect.transform(ctx.data, checkCtx);
      if (ctx.common.async) {
        return Promise.resolve(processed).then(async (processed2) => {
          if (status.value === "aborted")
            return INVALID;
          const result = await this._def.schema._parseAsync({
            data: processed2,
            path: ctx.path,
            parent: ctx
          });
          if (result.status === "aborted")
            return INVALID;
          if (result.status === "dirty")
            return DIRTY(result.value);
          if (status.value === "dirty")
            return DIRTY(result.value);
          return result;
        });
      } else {
        if (status.value === "aborted")
          return INVALID;
        const result = this._def.schema._parseSync({
          data: processed,
          path: ctx.path,
          parent: ctx
        });
        if (result.status === "aborted")
          return INVALID;
        if (result.status === "dirty")
          return DIRTY(result.value);
        if (status.value === "dirty")
          return DIRTY(result.value);
        return result;
      }
    }
    if (effect.type === "refinement") {
      const executeRefinement = (acc) => {
        const result = effect.refinement(acc, checkCtx);
        if (ctx.common.async) {
          return Promise.resolve(result);
        }
        if (result instanceof Promise) {
          throw new Error("Async refinement encountered during synchronous parse operation. Use .parseAsync instead.");
        }
        return acc;
      };
      if (ctx.common.async === false) {
        const inner = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inner.status === "aborted")
          return INVALID;
        if (inner.status === "dirty")
          status.dirty();
        executeRefinement(inner.value);
        return { status: status.value, value: inner.value };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((inner) => {
          if (inner.status === "aborted")
            return INVALID;
          if (inner.status === "dirty")
            status.dirty();
          return executeRefinement(inner.value).then(() => {
            return { status: status.value, value: inner.value };
          });
        });
      }
    }
    if (effect.type === "transform") {
      if (ctx.common.async === false) {
        const base = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (!isValid(base))
          return INVALID;
        const result = effect.transform(base.value, checkCtx);
        if (result instanceof Promise) {
          throw new Error(`Asynchronous transform encountered during synchronous parse operation. Use .parseAsync instead.`);
        }
        return { status: status.value, value: result };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((base) => {
          if (!isValid(base))
            return INVALID;
          return Promise.resolve(effect.transform(base.value, checkCtx)).then((result) => ({
            status: status.value,
            value: result
          }));
        });
      }
    }
    util.assertNever(effect);
  }
}
ZodEffects.create = (schema, effect, params) => {
  return new ZodEffects({
    schema,
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    effect,
    ...processCreateParams(params)
  });
};
ZodEffects.createWithPreprocess = (preprocess, schema, params) => {
  return new ZodEffects({
    schema,
    effect: { type: "preprocess", transform: preprocess },
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    ...processCreateParams(params)
  });
};
class ZodOptional extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.undefined) {
      return OK(undefined);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
}
ZodOptional.create = (type, params) => {
  return new ZodOptional({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodOptional,
    ...processCreateParams(params)
  });
};

class ZodNullable extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.null) {
      return OK(null);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
}
ZodNullable.create = (type, params) => {
  return new ZodNullable({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodNullable,
    ...processCreateParams(params)
  });
};

class ZodDefault extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    let data = ctx.data;
    if (ctx.parsedType === ZodParsedType.undefined) {
      data = this._def.defaultValue();
    }
    return this._def.innerType._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  removeDefault() {
    return this._def.innerType;
  }
}
ZodDefault.create = (type, params) => {
  return new ZodDefault({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodDefault,
    defaultValue: typeof params.default === "function" ? params.default : () => params.default,
    ...processCreateParams(params)
  });
};

class ZodCatch extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const newCtx = {
      ...ctx,
      common: {
        ...ctx.common,
        issues: []
      }
    };
    const result = this._def.innerType._parse({
      data: newCtx.data,
      path: newCtx.path,
      parent: {
        ...newCtx
      }
    });
    if (isAsync(result)) {
      return result.then((result2) => {
        return {
          status: "valid",
          value: result2.status === "valid" ? result2.value : this._def.catchValue({
            get error() {
              return new ZodError(newCtx.common.issues);
            },
            input: newCtx.data
          })
        };
      });
    } else {
      return {
        status: "valid",
        value: result.status === "valid" ? result.value : this._def.catchValue({
          get error() {
            return new ZodError(newCtx.common.issues);
          },
          input: newCtx.data
        })
      };
    }
  }
  removeCatch() {
    return this._def.innerType;
  }
}
ZodCatch.create = (type, params) => {
  return new ZodCatch({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodCatch,
    catchValue: typeof params.catch === "function" ? params.catch : () => params.catch,
    ...processCreateParams(params)
  });
};

class ZodNaN extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.nan) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.nan,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
}
ZodNaN.create = (params) => {
  return new ZodNaN({
    typeName: ZodFirstPartyTypeKind.ZodNaN,
    ...processCreateParams(params)
  });
};
var BRAND = Symbol("zod_brand");

class ZodBranded extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const data = ctx.data;
    return this._def.type._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  unwrap() {
    return this._def.type;
  }
}

class ZodPipeline extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.common.async) {
      const handleAsync = async () => {
        const inResult = await this._def.in._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inResult.status === "aborted")
          return INVALID;
        if (inResult.status === "dirty") {
          status.dirty();
          return DIRTY(inResult.value);
        } else {
          return this._def.out._parseAsync({
            data: inResult.value,
            path: ctx.path,
            parent: ctx
          });
        }
      };
      return handleAsync();
    } else {
      const inResult = this._def.in._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
      if (inResult.status === "aborted")
        return INVALID;
      if (inResult.status === "dirty") {
        status.dirty();
        return {
          status: "dirty",
          value: inResult.value
        };
      } else {
        return this._def.out._parseSync({
          data: inResult.value,
          path: ctx.path,
          parent: ctx
        });
      }
    }
  }
  static create(a, b) {
    return new ZodPipeline({
      in: a,
      out: b,
      typeName: ZodFirstPartyTypeKind.ZodPipeline
    });
  }
}

class ZodReadonly extends ZodType {
  _parse(input) {
    const result = this._def.innerType._parse(input);
    const freeze = (data) => {
      if (isValid(data)) {
        data.value = Object.freeze(data.value);
      }
      return data;
    };
    return isAsync(result) ? result.then((data) => freeze(data)) : freeze(result);
  }
  unwrap() {
    return this._def.innerType;
  }
}
ZodReadonly.create = (type, params) => {
  return new ZodReadonly({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodReadonly,
    ...processCreateParams(params)
  });
};
function cleanParams(params, data) {
  const p = typeof params === "function" ? params(data) : typeof params === "string" ? { message: params } : params;
  const p2 = typeof p === "string" ? { message: p } : p;
  return p2;
}
function custom(check, _params = {}, fatal) {
  if (check)
    return ZodAny.create().superRefine((data, ctx) => {
      const r = check(data);
      if (r instanceof Promise) {
        return r.then((r2) => {
          if (!r2) {
            const params = cleanParams(_params, data);
            const _fatal = params.fatal ?? fatal ?? true;
            ctx.addIssue({ code: "custom", ...params, fatal: _fatal });
          }
        });
      }
      if (!r) {
        const params = cleanParams(_params, data);
        const _fatal = params.fatal ?? fatal ?? true;
        ctx.addIssue({ code: "custom", ...params, fatal: _fatal });
      }
      return;
    });
  return ZodAny.create();
}
var late = {
  object: ZodObject.lazycreate
};
var ZodFirstPartyTypeKind;
(function(ZodFirstPartyTypeKind2) {
  ZodFirstPartyTypeKind2["ZodString"] = "ZodString";
  ZodFirstPartyTypeKind2["ZodNumber"] = "ZodNumber";
  ZodFirstPartyTypeKind2["ZodNaN"] = "ZodNaN";
  ZodFirstPartyTypeKind2["ZodBigInt"] = "ZodBigInt";
  ZodFirstPartyTypeKind2["ZodBoolean"] = "ZodBoolean";
  ZodFirstPartyTypeKind2["ZodDate"] = "ZodDate";
  ZodFirstPartyTypeKind2["ZodSymbol"] = "ZodSymbol";
  ZodFirstPartyTypeKind2["ZodUndefined"] = "ZodUndefined";
  ZodFirstPartyTypeKind2["ZodNull"] = "ZodNull";
  ZodFirstPartyTypeKind2["ZodAny"] = "ZodAny";
  ZodFirstPartyTypeKind2["ZodUnknown"] = "ZodUnknown";
  ZodFirstPartyTypeKind2["ZodNever"] = "ZodNever";
  ZodFirstPartyTypeKind2["ZodVoid"] = "ZodVoid";
  ZodFirstPartyTypeKind2["ZodArray"] = "ZodArray";
  ZodFirstPartyTypeKind2["ZodObject"] = "ZodObject";
  ZodFirstPartyTypeKind2["ZodUnion"] = "ZodUnion";
  ZodFirstPartyTypeKind2["ZodDiscriminatedUnion"] = "ZodDiscriminatedUnion";
  ZodFirstPartyTypeKind2["ZodIntersection"] = "ZodIntersection";
  ZodFirstPartyTypeKind2["ZodTuple"] = "ZodTuple";
  ZodFirstPartyTypeKind2["ZodRecord"] = "ZodRecord";
  ZodFirstPartyTypeKind2["ZodMap"] = "ZodMap";
  ZodFirstPartyTypeKind2["ZodSet"] = "ZodSet";
  ZodFirstPartyTypeKind2["ZodFunction"] = "ZodFunction";
  ZodFirstPartyTypeKind2["ZodLazy"] = "ZodLazy";
  ZodFirstPartyTypeKind2["ZodLiteral"] = "ZodLiteral";
  ZodFirstPartyTypeKind2["ZodEnum"] = "ZodEnum";
  ZodFirstPartyTypeKind2["ZodEffects"] = "ZodEffects";
  ZodFirstPartyTypeKind2["ZodNativeEnum"] = "ZodNativeEnum";
  ZodFirstPartyTypeKind2["ZodOptional"] = "ZodOptional";
  ZodFirstPartyTypeKind2["ZodNullable"] = "ZodNullable";
  ZodFirstPartyTypeKind2["ZodDefault"] = "ZodDefault";
  ZodFirstPartyTypeKind2["ZodCatch"] = "ZodCatch";
  ZodFirstPartyTypeKind2["ZodPromise"] = "ZodPromise";
  ZodFirstPartyTypeKind2["ZodBranded"] = "ZodBranded";
  ZodFirstPartyTypeKind2["ZodPipeline"] = "ZodPipeline";
  ZodFirstPartyTypeKind2["ZodReadonly"] = "ZodReadonly";
})(ZodFirstPartyTypeKind || (ZodFirstPartyTypeKind = {}));
var instanceOfType = (cls, params = {
  message: `Input not instance of ${cls.name}`
}) => custom((data) => data instanceof cls, params);
var stringType = ZodString.create;
var numberType = ZodNumber.create;
var nanType = ZodNaN.create;
var bigIntType = ZodBigInt.create;
var booleanType = ZodBoolean.create;
var dateType = ZodDate.create;
var symbolType = ZodSymbol.create;
var undefinedType = ZodUndefined.create;
var nullType = ZodNull.create;
var anyType = ZodAny.create;
var unknownType = ZodUnknown.create;
var neverType = ZodNever.create;
var voidType = ZodVoid.create;
var arrayType = ZodArray.create;
var objectType = ZodObject.create;
var strictObjectType = ZodObject.strictCreate;
var unionType = ZodUnion.create;
var discriminatedUnionType = ZodDiscriminatedUnion.create;
var intersectionType = ZodIntersection.create;
var tupleType = ZodTuple.create;
var recordType = ZodRecord.create;
var mapType = ZodMap.create;
var setType = ZodSet.create;
var functionType = ZodFunction.create;
var lazyType = ZodLazy.create;
var literalType = ZodLiteral.create;
var enumType = ZodEnum.create;
var nativeEnumType = ZodNativeEnum.create;
var promiseType = ZodPromise.create;
var effectsType = ZodEffects.create;
var optionalType = ZodOptional.create;
var nullableType = ZodNullable.create;
var preprocessType = ZodEffects.createWithPreprocess;
var pipelineType = ZodPipeline.create;
var ostring = () => stringType().optional();
var onumber = () => numberType().optional();
var oboolean = () => booleanType().optional();
var coerce = {
  string: (arg) => ZodString.create({ ...arg, coerce: true }),
  number: (arg) => ZodNumber.create({ ...arg, coerce: true }),
  boolean: (arg) => ZodBoolean.create({
    ...arg,
    coerce: true
  }),
  bigint: (arg) => ZodBigInt.create({ ...arg, coerce: true }),
  date: (arg) => ZodDate.create({ ...arg, coerce: true })
};
var NEVER = INVALID;
// node_modules/@zed-industries/agent-client-protocol/dist/schema.js
var AGENT_METHODS = {
  authenticate: "authenticate",
  initialize: "initialize",
  session_cancel: "session/cancel",
  session_load: "session/load",
  session_new: "session/new",
  session_prompt: "session/prompt",
  session_set_mode: "session/set_mode",
  session_set_model: "session/set_model"
};
var CLIENT_METHODS = {
  fs_read_text_file: "fs/read_text_file",
  fs_write_text_file: "fs/write_text_file",
  session_request_permission: "session/request_permission",
  session_update: "session/update",
  terminal_create: "terminal/create",
  terminal_kill: "terminal/kill",
  terminal_output: "terminal/output",
  terminal_release: "terminal/release",
  terminal_wait_for_exit: "terminal/wait_for_exit"
};
var PROTOCOL_VERSION = 1;
var writeTextFileRequestSchema = exports_external.object({
  _meta: exports_external.record(exports_external.unknown()).optional(),
  content: exports_external.string(),
  path: exports_external.string(),
  sessionId: exports_external.string()
});
var readTextFileRequestSchema = exports_external.object({
  _meta: exports_external.record(exports_external.unknown()).optional(),
  limit: exports_external.number().optional().nullable(),
  line: exports_external.number().optional().nullable(),
  path: exports_external.string(),
  sessionId: exports_external.string()
});
var terminalOutputRequestSchema = exports_external.object({
  _meta: exports_external.record(exports_external.unknown()).optional(),
  sessionId: exports_external.string(),
  terminalId: exports_external.string()
});
var releaseTerminalRequestSchema = exports_external.object({
  _meta: exports_external.record(exports_external.unknown()).optional(),
  sessionId: exports_external.string(),
  terminalId: exports_external.string()
});
var waitForTerminalExitRequestSchema = exports_external.object({
  _meta: exports_external.record(exports_external.unknown()).optional(),
  sessionId: exports_external.string(),
  terminalId: exports_external.string()
});
var killTerminalCommandRequestSchema = exports_external.object({
  _meta: exports_external.record(exports_external.unknown()).optional(),
  sessionId: exports_external.string(),
  terminalId: exports_external.string()
});
var extMethodRequestSchema = exports_external.record(exports_external.unknown());
var roleSchema = exports_external.union([exports_external.literal("assistant"), exports_external.literal("user")]);
var textResourceContentsSchema = exports_external.object({
  _meta: exports_external.record(exports_external.unknown()).optional(),
  mimeType: exports_external.string().optional().nullable(),
  text: exports_external.string(),
  uri: exports_external.string()
});
var blobResourceContentsSchema = exports_external.object({
  _meta: exports_external.record(exports_external.unknown()).optional(),
  blob: exports_external.string(),
  mimeType: exports_external.string().optional().nullable(),
  uri: exports_external.string()
});
var toolKindSchema = exports_external.union([
  exports_external.literal("read"),
  exports_external.literal("edit"),
  exports_external.literal("delete"),
  exports_external.literal("move"),
  exports_external.literal("search"),
  exports_external.literal("execute"),
  exports_external.literal("think"),
  exports_external.literal("fetch"),
  exports_external.literal("switch_mode"),
  exports_external.literal("other")
]);
var toolCallStatusSchema = exports_external.union([
  exports_external.literal("pending"),
  exports_external.literal("in_progress"),
  exports_external.literal("completed"),
  exports_external.literal("failed")
]);
var writeTextFileResponseSchema = exports_external.object({
  _meta: exports_external.record(exports_external.unknown()).optional()
});
var readTextFileResponseSchema = exports_external.object({
  _meta: exports_external.record(exports_external.unknown()).optional(),
  content: exports_external.string()
});
var requestPermissionResponseSchema = exports_external.object({
  _meta: exports_external.record(exports_external.unknown()).optional(),
  outcome: exports_external.union([
    exports_external.object({
      outcome: exports_external.literal("cancelled")
    }),
    exports_external.object({
      optionId: exports_external.string(),
      outcome: exports_external.literal("selected")
    })
  ])
});
var createTerminalResponseSchema = exports_external.object({
  _meta: exports_external.record(exports_external.unknown()).optional(),
  terminalId: exports_external.string()
});
var releaseTerminalResponseSchema = exports_external.object({
  _meta: exports_external.record(exports_external.unknown()).optional()
});
var waitForTerminalExitResponseSchema = exports_external.object({
  _meta: exports_external.record(exports_external.unknown()).optional(),
  exitCode: exports_external.number().optional().nullable(),
  signal: exports_external.string().optional().nullable()
});
var killTerminalResponseSchema = exports_external.object({
  _meta: exports_external.record(exports_external.unknown()).optional()
});
var extMethodResponseSchema = exports_external.record(exports_external.unknown());
var cancelNotificationSchema = exports_external.object({
  _meta: exports_external.record(exports_external.unknown()).optional(),
  sessionId: exports_external.string()
});
var extNotificationSchema = exports_external.record(exports_external.unknown());
var authenticateRequestSchema = exports_external.object({
  _meta: exports_external.record(exports_external.unknown()).optional(),
  methodId: exports_external.string()
});
var setSessionModeRequestSchema = exports_external.object({
  _meta: exports_external.record(exports_external.unknown()).optional(),
  modeId: exports_external.string(),
  sessionId: exports_external.string()
});
var setSessionModelRequestSchema = exports_external.object({
  _meta: exports_external.record(exports_external.unknown()).optional(),
  modelId: exports_external.string(),
  sessionId: exports_external.string()
});
var extMethodRequest1Schema = exports_external.record(exports_external.unknown());
var httpHeaderSchema = exports_external.object({
  _meta: exports_external.record(exports_external.unknown()).optional(),
  name: exports_external.string(),
  value: exports_external.string()
});
var annotationsSchema = exports_external.object({
  _meta: exports_external.record(exports_external.unknown()).optional(),
  audience: exports_external.array(roleSchema).optional().nullable(),
  lastModified: exports_external.string().optional().nullable(),
  priority: exports_external.number().optional().nullable()
});
var embeddedResourceResourceSchema = exports_external.union([
  textResourceContentsSchema,
  blobResourceContentsSchema
]);
var authenticateResponseSchema = exports_external.object({
  _meta: exports_external.record(exports_external.unknown()).optional()
});
var setSessionModeResponseSchema = exports_external.object({
  meta: exports_external.unknown().optional()
});
var promptResponseSchema = exports_external.object({
  _meta: exports_external.record(exports_external.unknown()).optional(),
  stopReason: exports_external.union([
    exports_external.literal("end_turn"),
    exports_external.literal("max_tokens"),
    exports_external.literal("max_turn_requests"),
    exports_external.literal("refusal"),
    exports_external.literal("cancelled")
  ])
});
var setSessionModelResponseSchema = exports_external.object({
  _meta: exports_external.record(exports_external.unknown()).optional()
});
var extMethodResponse1Schema = exports_external.record(exports_external.unknown());
var sessionModeIdSchema = exports_external.string();
var extNotification1Schema = exports_external.record(exports_external.unknown());
var unstructuredCommandInputSchema = exports_external.object({
  hint: exports_external.string()
});
var permissionOptionSchema = exports_external.object({
  _meta: exports_external.record(exports_external.unknown()).optional(),
  kind: exports_external.union([
    exports_external.literal("allow_once"),
    exports_external.literal("allow_always"),
    exports_external.literal("reject_once"),
    exports_external.literal("reject_always")
  ]),
  name: exports_external.string(),
  optionId: exports_external.string()
});
var toolCallContentSchema = exports_external.union([
  exports_external.object({
    content: exports_external.union([
      exports_external.object({
        _meta: exports_external.record(exports_external.unknown()).optional(),
        annotations: annotationsSchema.optional().nullable(),
        text: exports_external.string(),
        type: exports_external.literal("text")
      }),
      exports_external.object({
        _meta: exports_external.record(exports_external.unknown()).optional(),
        annotations: annotationsSchema.optional().nullable(),
        data: exports_external.string(),
        mimeType: exports_external.string(),
        type: exports_external.literal("image"),
        uri: exports_external.string().optional().nullable()
      }),
      exports_external.object({
        _meta: exports_external.record(exports_external.unknown()).optional(),
        annotations: annotationsSchema.optional().nullable(),
        data: exports_external.string(),
        mimeType: exports_external.string(),
        type: exports_external.literal("audio")
      }),
      exports_external.object({
        _meta: exports_external.record(exports_external.unknown()).optional(),
        annotations: annotationsSchema.optional().nullable(),
        description: exports_external.string().optional().nullable(),
        mimeType: exports_external.string().optional().nullable(),
        name: exports_external.string(),
        size: exports_external.number().optional().nullable(),
        title: exports_external.string().optional().nullable(),
        type: exports_external.literal("resource_link"),
        uri: exports_external.string()
      }),
      exports_external.object({
        _meta: exports_external.record(exports_external.unknown()).optional(),
        annotations: annotationsSchema.optional().nullable(),
        resource: embeddedResourceResourceSchema,
        type: exports_external.literal("resource")
      })
    ]),
    type: exports_external.literal("content")
  }),
  exports_external.object({
    _meta: exports_external.record(exports_external.unknown()).optional(),
    newText: exports_external.string(),
    oldText: exports_external.string().optional().nullable(),
    path: exports_external.string(),
    type: exports_external.literal("diff")
  }),
  exports_external.object({
    terminalId: exports_external.string(),
    type: exports_external.literal("terminal")
  })
]);
var toolCallLocationSchema = exports_external.object({
  _meta: exports_external.record(exports_external.unknown()).optional(),
  line: exports_external.number().optional().nullable(),
  path: exports_external.string()
});
var envVariableSchema = exports_external.object({
  _meta: exports_external.record(exports_external.unknown()).optional(),
  name: exports_external.string(),
  value: exports_external.string()
});
var terminalExitStatusSchema = exports_external.object({
  _meta: exports_external.record(exports_external.unknown()).optional(),
  exitCode: exports_external.number().optional().nullable(),
  signal: exports_external.string().optional().nullable()
});
var fileSystemCapabilitySchema = exports_external.object({
  _meta: exports_external.record(exports_external.unknown()).optional(),
  readTextFile: exports_external.boolean().optional(),
  writeTextFile: exports_external.boolean().optional()
});
var stdioSchema = exports_external.object({
  args: exports_external.array(exports_external.string()),
  command: exports_external.string(),
  env: exports_external.array(envVariableSchema),
  name: exports_external.string()
});
var mcpServerSchema = exports_external.union([
  exports_external.object({
    headers: exports_external.array(httpHeaderSchema),
    name: exports_external.string(),
    type: exports_external.literal("http"),
    url: exports_external.string()
  }),
  exports_external.object({
    headers: exports_external.array(httpHeaderSchema),
    name: exports_external.string(),
    type: exports_external.literal("sse"),
    url: exports_external.string()
  }),
  stdioSchema
]);
var contentBlockSchema = exports_external.union([
  exports_external.object({
    _meta: exports_external.record(exports_external.unknown()).optional(),
    annotations: annotationsSchema.optional().nullable(),
    text: exports_external.string(),
    type: exports_external.literal("text")
  }),
  exports_external.object({
    _meta: exports_external.record(exports_external.unknown()).optional(),
    annotations: annotationsSchema.optional().nullable(),
    data: exports_external.string(),
    mimeType: exports_external.string(),
    type: exports_external.literal("image"),
    uri: exports_external.string().optional().nullable()
  }),
  exports_external.object({
    _meta: exports_external.record(exports_external.unknown()).optional(),
    annotations: annotationsSchema.optional().nullable(),
    data: exports_external.string(),
    mimeType: exports_external.string(),
    type: exports_external.literal("audio")
  }),
  exports_external.object({
    _meta: exports_external.record(exports_external.unknown()).optional(),
    annotations: annotationsSchema.optional().nullable(),
    description: exports_external.string().optional().nullable(),
    mimeType: exports_external.string().optional().nullable(),
    name: exports_external.string(),
    size: exports_external.number().optional().nullable(),
    title: exports_external.string().optional().nullable(),
    type: exports_external.literal("resource_link"),
    uri: exports_external.string()
  }),
  exports_external.object({
    _meta: exports_external.record(exports_external.unknown()).optional(),
    annotations: annotationsSchema.optional().nullable(),
    resource: embeddedResourceResourceSchema,
    type: exports_external.literal("resource")
  })
]);
var authMethodSchema = exports_external.object({
  _meta: exports_external.record(exports_external.unknown()).optional(),
  description: exports_external.string().optional().nullable(),
  id: exports_external.string(),
  name: exports_external.string()
});
var mcpCapabilitiesSchema = exports_external.object({
  _meta: exports_external.record(exports_external.unknown()).optional(),
  http: exports_external.boolean().optional(),
  sse: exports_external.boolean().optional()
});
var promptCapabilitiesSchema = exports_external.object({
  _meta: exports_external.record(exports_external.unknown()).optional(),
  audio: exports_external.boolean().optional(),
  embeddedContext: exports_external.boolean().optional(),
  image: exports_external.boolean().optional()
});
var modelInfoSchema = exports_external.object({
  _meta: exports_external.record(exports_external.unknown()).optional(),
  description: exports_external.string().optional().nullable(),
  modelId: exports_external.string(),
  name: exports_external.string()
});
var sessionModeSchema = exports_external.object({
  _meta: exports_external.record(exports_external.unknown()).optional(),
  description: exports_external.string().optional().nullable(),
  id: sessionModeIdSchema,
  name: exports_external.string()
});
var sessionModelStateSchema = exports_external.object({
  _meta: exports_external.record(exports_external.unknown()).optional(),
  availableModels: exports_external.array(modelInfoSchema),
  currentModelId: exports_external.string()
});
var sessionModeStateSchema = exports_external.object({
  _meta: exports_external.record(exports_external.unknown()).optional(),
  availableModes: exports_external.array(sessionModeSchema),
  currentModeId: exports_external.string()
});
var planEntrySchema = exports_external.object({
  _meta: exports_external.record(exports_external.unknown()).optional(),
  content: exports_external.string(),
  priority: exports_external.union([exports_external.literal("high"), exports_external.literal("medium"), exports_external.literal("low")]),
  status: exports_external.union([
    exports_external.literal("pending"),
    exports_external.literal("in_progress"),
    exports_external.literal("completed")
  ])
});
var availableCommandInputSchema = unstructuredCommandInputSchema;
var clientNotificationSchema = exports_external.union([
  cancelNotificationSchema,
  extNotificationSchema
]);
var createTerminalRequestSchema = exports_external.object({
  _meta: exports_external.record(exports_external.unknown()).optional(),
  args: exports_external.array(exports_external.string()).optional(),
  command: exports_external.string(),
  cwd: exports_external.string().optional().nullable(),
  env: exports_external.array(envVariableSchema).optional(),
  outputByteLimit: exports_external.number().optional().nullable(),
  sessionId: exports_external.string()
});
var terminalOutputResponseSchema = exports_external.object({
  _meta: exports_external.record(exports_external.unknown()).optional(),
  exitStatus: terminalExitStatusSchema.optional().nullable(),
  output: exports_external.string(),
  truncated: exports_external.boolean()
});
var newSessionRequestSchema = exports_external.object({
  _meta: exports_external.record(exports_external.unknown()).optional(),
  cwd: exports_external.string(),
  mcpServers: exports_external.array(mcpServerSchema)
});
var loadSessionRequestSchema = exports_external.object({
  _meta: exports_external.record(exports_external.unknown()).optional(),
  cwd: exports_external.string(),
  mcpServers: exports_external.array(mcpServerSchema),
  sessionId: exports_external.string()
});
var promptRequestSchema = exports_external.object({
  _meta: exports_external.record(exports_external.unknown()).optional(),
  prompt: exports_external.array(contentBlockSchema),
  sessionId: exports_external.string()
});
var newSessionResponseSchema = exports_external.object({
  _meta: exports_external.record(exports_external.unknown()).optional(),
  models: sessionModelStateSchema.optional().nullable(),
  modes: sessionModeStateSchema.optional().nullable(),
  sessionId: exports_external.string()
});
var loadSessionResponseSchema = exports_external.object({
  _meta: exports_external.record(exports_external.unknown()).optional(),
  models: sessionModelStateSchema.optional().nullable(),
  modes: sessionModeStateSchema.optional().nullable()
});
var toolCallUpdateSchema = exports_external.object({
  _meta: exports_external.record(exports_external.unknown()).optional(),
  content: exports_external.array(toolCallContentSchema).optional().nullable(),
  kind: toolKindSchema.optional().nullable(),
  locations: exports_external.array(toolCallLocationSchema).optional().nullable(),
  rawInput: exports_external.record(exports_external.unknown()).optional(),
  rawOutput: exports_external.record(exports_external.unknown()).optional(),
  status: toolCallStatusSchema.optional().nullable(),
  title: exports_external.string().optional().nullable(),
  toolCallId: exports_external.string()
});
var clientCapabilitiesSchema = exports_external.object({
  _meta: exports_external.record(exports_external.unknown()).optional(),
  fs: fileSystemCapabilitySchema.optional(),
  terminal: exports_external.boolean().optional()
});
var agentCapabilitiesSchema = exports_external.object({
  _meta: exports_external.record(exports_external.unknown()).optional(),
  loadSession: exports_external.boolean().optional(),
  mcpCapabilities: mcpCapabilitiesSchema.optional(),
  promptCapabilities: promptCapabilitiesSchema.optional()
});
var availableCommandSchema = exports_external.object({
  _meta: exports_external.record(exports_external.unknown()).optional(),
  description: exports_external.string(),
  input: availableCommandInputSchema.optional().nullable(),
  name: exports_external.string()
});
var clientResponseSchema = exports_external.union([
  writeTextFileResponseSchema,
  readTextFileResponseSchema,
  requestPermissionResponseSchema,
  createTerminalResponseSchema,
  terminalOutputResponseSchema,
  releaseTerminalResponseSchema,
  waitForTerminalExitResponseSchema,
  killTerminalResponseSchema,
  extMethodResponseSchema
]);
var requestPermissionRequestSchema = exports_external.object({
  _meta: exports_external.record(exports_external.unknown()).optional(),
  options: exports_external.array(permissionOptionSchema),
  sessionId: exports_external.string(),
  toolCall: toolCallUpdateSchema
});
var initializeRequestSchema = exports_external.object({
  _meta: exports_external.record(exports_external.unknown()).optional(),
  clientCapabilities: clientCapabilitiesSchema.optional(),
  protocolVersion: exports_external.number()
});
var initializeResponseSchema = exports_external.object({
  _meta: exports_external.record(exports_external.unknown()).optional(),
  agentCapabilities: agentCapabilitiesSchema.optional(),
  authMethods: exports_external.array(authMethodSchema).optional(),
  protocolVersion: exports_external.number()
});
var sessionNotificationSchema = exports_external.object({
  _meta: exports_external.record(exports_external.unknown()).optional(),
  sessionId: exports_external.string(),
  update: exports_external.union([
    exports_external.object({
      content: contentBlockSchema,
      sessionUpdate: exports_external.literal("user_message_chunk")
    }),
    exports_external.object({
      content: contentBlockSchema,
      sessionUpdate: exports_external.literal("agent_message_chunk")
    }),
    exports_external.object({
      content: contentBlockSchema,
      sessionUpdate: exports_external.literal("agent_thought_chunk")
    }),
    exports_external.object({
      _meta: exports_external.record(exports_external.unknown()).optional(),
      content: exports_external.array(toolCallContentSchema).optional(),
      kind: exports_external.union([
        exports_external.literal("read"),
        exports_external.literal("edit"),
        exports_external.literal("delete"),
        exports_external.literal("move"),
        exports_external.literal("search"),
        exports_external.literal("execute"),
        exports_external.literal("think"),
        exports_external.literal("fetch"),
        exports_external.literal("switch_mode"),
        exports_external.literal("other")
      ]).optional(),
      locations: exports_external.array(toolCallLocationSchema).optional(),
      rawInput: exports_external.record(exports_external.unknown()).optional(),
      rawOutput: exports_external.record(exports_external.unknown()).optional(),
      sessionUpdate: exports_external.literal("tool_call"),
      status: exports_external.union([
        exports_external.literal("pending"),
        exports_external.literal("in_progress"),
        exports_external.literal("completed"),
        exports_external.literal("failed")
      ]).optional(),
      title: exports_external.string(),
      toolCallId: exports_external.string()
    }),
    exports_external.object({
      _meta: exports_external.record(exports_external.unknown()).optional(),
      content: exports_external.array(toolCallContentSchema).optional().nullable(),
      kind: toolKindSchema.optional().nullable(),
      locations: exports_external.array(toolCallLocationSchema).optional().nullable(),
      rawInput: exports_external.record(exports_external.unknown()).optional(),
      rawOutput: exports_external.record(exports_external.unknown()).optional(),
      sessionUpdate: exports_external.literal("tool_call_update"),
      status: toolCallStatusSchema.optional().nullable(),
      title: exports_external.string().optional().nullable(),
      toolCallId: exports_external.string()
    }),
    exports_external.object({
      _meta: exports_external.record(exports_external.unknown()).optional(),
      entries: exports_external.array(planEntrySchema),
      sessionUpdate: exports_external.literal("plan")
    }),
    exports_external.object({
      availableCommands: exports_external.array(availableCommandSchema),
      sessionUpdate: exports_external.literal("available_commands_update")
    }),
    exports_external.object({
      currentModeId: sessionModeIdSchema,
      sessionUpdate: exports_external.literal("current_mode_update")
    })
  ])
});
var clientRequestSchema = exports_external.union([
  writeTextFileRequestSchema,
  readTextFileRequestSchema,
  requestPermissionRequestSchema,
  createTerminalRequestSchema,
  terminalOutputRequestSchema,
  releaseTerminalRequestSchema,
  waitForTerminalExitRequestSchema,
  killTerminalCommandRequestSchema,
  extMethodRequestSchema
]);
var agentRequestSchema = exports_external.union([
  initializeRequestSchema,
  authenticateRequestSchema,
  newSessionRequestSchema,
  loadSessionRequestSchema,
  setSessionModeRequestSchema,
  promptRequestSchema,
  setSessionModelRequestSchema,
  extMethodRequest1Schema
]);
var agentResponseSchema = exports_external.union([
  initializeResponseSchema,
  authenticateResponseSchema,
  newSessionResponseSchema,
  loadSessionResponseSchema,
  setSessionModeResponseSchema,
  promptResponseSchema,
  setSessionModelResponseSchema,
  extMethodResponse1Schema
]);
var agentNotificationSchema = exports_external.union([
  sessionNotificationSchema,
  extNotification1Schema
]);
var agentClientProtocolSchema = exports_external.union([
  clientRequestSchema,
  clientResponseSchema,
  clientNotificationSchema,
  agentRequestSchema,
  agentResponseSchema,
  agentNotificationSchema
]);
// node_modules/@zed-industries/agent-client-protocol/dist/stream.js
function ndJsonStream(output, input) {
  const textEncoder = new TextEncoder;
  const textDecoder = new TextDecoder;
  const readable = new ReadableStream({
    async start(controller) {
      let content = "";
      const reader = input.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          if (!value) {
            continue;
          }
          content += textDecoder.decode(value, { stream: true });
          const lines = content.split(`
`);
          content = lines.pop() || "";
          for (const line of lines) {
            const trimmedLine = line.trim();
            if (trimmedLine) {
              try {
                const message = JSON.parse(trimmedLine);
                controller.enqueue(message);
              } catch (err) {
                console.error("Failed to parse JSON message:", trimmedLine, err);
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
        controller.close();
      }
    }
  });
  const writable = new WritableStream({
    async write(message) {
      const content = JSON.stringify(message) + `
`;
      const writer = output.getWriter();
      try {
        await writer.write(textEncoder.encode(content));
      } finally {
        writer.releaseLock();
      }
    }
  });
  return { readable, writable };
}

// node_modules/@zed-industries/agent-client-protocol/dist/acp.js
class AgentSideConnection {
  #connection;
  constructor(toAgent, stream2) {
    const agent = toAgent(this);
    const requestHandler = async (method, params) => {
      switch (method) {
        case AGENT_METHODS.initialize: {
          const validatedParams = initializeRequestSchema.parse(params);
          return agent.initialize(validatedParams);
        }
        case AGENT_METHODS.session_new: {
          const validatedParams = newSessionRequestSchema.parse(params);
          return agent.newSession(validatedParams);
        }
        case AGENT_METHODS.session_load: {
          if (!agent.loadSession) {
            throw RequestError.methodNotFound(method);
          }
          const validatedParams = loadSessionRequestSchema.parse(params);
          return agent.loadSession(validatedParams);
        }
        case AGENT_METHODS.session_set_mode: {
          if (!agent.setSessionMode) {
            throw RequestError.methodNotFound(method);
          }
          const validatedParams = setSessionModeRequestSchema.parse(params);
          const result = await agent.setSessionMode(validatedParams);
          return result ?? {};
        }
        case AGENT_METHODS.authenticate: {
          const validatedParams = authenticateRequestSchema.parse(params);
          const result = await agent.authenticate(validatedParams);
          return result ?? {};
        }
        case AGENT_METHODS.session_prompt: {
          const validatedParams = promptRequestSchema.parse(params);
          return agent.prompt(validatedParams);
        }
        case AGENT_METHODS.session_set_model: {
          if (!agent.setSessionModel) {
            throw RequestError.methodNotFound(method);
          }
          const validatedParams = setSessionModelRequestSchema.parse(params);
          return agent.setSessionModel(validatedParams);
        }
        default:
          if (method.startsWith("_")) {
            if (!agent.extMethod) {
              throw RequestError.methodNotFound(method);
            }
            return agent.extMethod(method.substring(1), params);
          }
          throw RequestError.methodNotFound(method);
      }
    };
    const notificationHandler = async (method, params) => {
      switch (method) {
        case AGENT_METHODS.session_cancel: {
          const validatedParams = cancelNotificationSchema.parse(params);
          return agent.cancel(validatedParams);
        }
        default:
          if (method.startsWith("_")) {
            if (!agent.extNotification) {
              return;
            }
            return agent.extNotification(method.substring(1), params);
          }
          throw RequestError.methodNotFound(method);
      }
    };
    this.#connection = new Connection(requestHandler, notificationHandler, stream2);
  }
  async sessionUpdate(params) {
    return await this.#connection.sendNotification(CLIENT_METHODS.session_update, params);
  }
  async requestPermission(params) {
    return await this.#connection.sendRequest(CLIENT_METHODS.session_request_permission, params);
  }
  async readTextFile(params) {
    return await this.#connection.sendRequest(CLIENT_METHODS.fs_read_text_file, params);
  }
  async writeTextFile(params) {
    return await this.#connection.sendRequest(CLIENT_METHODS.fs_write_text_file, params) ?? {};
  }
  async createTerminal(params) {
    const response = await this.#connection.sendRequest(CLIENT_METHODS.terminal_create, params);
    return new TerminalHandle(response.terminalId, params.sessionId, this.#connection);
  }
  async extMethod(method, params) {
    return await this.#connection.sendRequest(`_${method}`, params);
  }
  async extNotification(method, params) {
    return await this.#connection.sendNotification(`_${method}`, params);
  }
}

class TerminalHandle {
  id;
  #sessionId;
  #connection;
  constructor(id, sessionId, conn) {
    this.id = id;
    this.#sessionId = sessionId;
    this.#connection = conn;
  }
  async currentOutput() {
    return await this.#connection.sendRequest(CLIENT_METHODS.terminal_output, {
      sessionId: this.#sessionId,
      terminalId: this.id
    });
  }
  async waitForExit() {
    return await this.#connection.sendRequest(CLIENT_METHODS.terminal_wait_for_exit, {
      sessionId: this.#sessionId,
      terminalId: this.id
    });
  }
  async kill() {
    return await this.#connection.sendRequest(CLIENT_METHODS.terminal_kill, {
      sessionId: this.#sessionId,
      terminalId: this.id
    }) ?? {};
  }
  async release() {
    return await this.#connection.sendRequest(CLIENT_METHODS.terminal_release, {
      sessionId: this.#sessionId,
      terminalId: this.id
    }) ?? {};
  }
  async[Symbol.asyncDispose]() {
    await this.release();
  }
}

class ClientSideConnection {
  #connection;
  constructor(toClient, stream2) {
    const client = toClient(this);
    const requestHandler = async (method, params) => {
      switch (method) {
        case CLIENT_METHODS.fs_write_text_file: {
          const validatedParams = writeTextFileRequestSchema.parse(params);
          return client.writeTextFile?.(validatedParams);
        }
        case CLIENT_METHODS.fs_read_text_file: {
          const validatedParams = readTextFileRequestSchema.parse(params);
          return client.readTextFile?.(validatedParams);
        }
        case CLIENT_METHODS.session_request_permission: {
          const validatedParams = requestPermissionRequestSchema.parse(params);
          return client.requestPermission(validatedParams);
        }
        case CLIENT_METHODS.terminal_create: {
          const validatedParams = createTerminalRequestSchema.parse(params);
          return client.createTerminal?.(validatedParams);
        }
        case CLIENT_METHODS.terminal_output: {
          const validatedParams = terminalOutputRequestSchema.parse(params);
          return client.terminalOutput?.(validatedParams);
        }
        case CLIENT_METHODS.terminal_release: {
          const validatedParams = releaseTerminalRequestSchema.parse(params);
          const result = await client.releaseTerminal?.(validatedParams);
          return result ?? {};
        }
        case CLIENT_METHODS.terminal_wait_for_exit: {
          const validatedParams = waitForTerminalExitRequestSchema.parse(params);
          return client.waitForTerminalExit?.(validatedParams);
        }
        case CLIENT_METHODS.terminal_kill: {
          const validatedParams = killTerminalCommandRequestSchema.parse(params);
          const result = await client.killTerminal?.(validatedParams);
          return result ?? {};
        }
        default:
          if (method.startsWith("_")) {
            const customMethod = method.substring(1);
            if (!client.extMethod) {
              throw RequestError.methodNotFound(method);
            }
            return client.extMethod(customMethod, params);
          }
          throw RequestError.methodNotFound(method);
      }
    };
    const notificationHandler = async (method, params) => {
      switch (method) {
        case CLIENT_METHODS.session_update: {
          const validatedParams = sessionNotificationSchema.parse(params);
          return client.sessionUpdate(validatedParams);
        }
        default:
          if (method.startsWith("_")) {
            const customMethod = method.substring(1);
            if (!client.extNotification) {
              return;
            }
            return client.extNotification(customMethod, params);
          }
          throw RequestError.methodNotFound(method);
      }
    };
    this.#connection = new Connection(requestHandler, notificationHandler, stream2);
  }
  async initialize(params) {
    return await this.#connection.sendRequest(AGENT_METHODS.initialize, params);
  }
  async newSession(params) {
    return await this.#connection.sendRequest(AGENT_METHODS.session_new, params);
  }
  async loadSession(params) {
    return await this.#connection.sendRequest(AGENT_METHODS.session_load, params) ?? {};
  }
  async setSessionMode(params) {
    return await this.#connection.sendRequest(AGENT_METHODS.session_set_mode, params) ?? {};
  }
  async setSessionModel(params) {
    return await this.#connection.sendRequest(AGENT_METHODS.session_set_mode, params) ?? {};
  }
  async authenticate(params) {
    return await this.#connection.sendRequest(AGENT_METHODS.authenticate, params) ?? {};
  }
  async prompt(params) {
    return await this.#connection.sendRequest(AGENT_METHODS.session_prompt, params);
  }
  async cancel(params) {
    return await this.#connection.sendNotification(AGENT_METHODS.session_cancel, params);
  }
  async extMethod(method, params) {
    return await this.#connection.sendRequest(`_${method}`, params);
  }
  async extNotification(method, params) {
    return await this.#connection.sendNotification(`_${method}`, params);
  }
}

class Connection {
  #pendingResponses = new Map;
  #nextRequestId = 0;
  #requestHandler;
  #notificationHandler;
  #stream;
  #writeQueue = Promise.resolve();
  constructor(requestHandler, notificationHandler, stream2) {
    this.#requestHandler = requestHandler;
    this.#notificationHandler = notificationHandler;
    this.#stream = stream2;
    this.#receive();
  }
  async#receive() {
    const reader = this.#stream.readable.getReader();
    try {
      while (true) {
        const { value: message, done } = await reader.read();
        if (done) {
          break;
        }
        if (!message) {
          continue;
        }
        try {
          this.#processMessage(message);
        } catch (err) {
          console.error("Unexpected error during message processing:", message, err);
          if ("id" in message && message.id !== undefined) {
            this.#sendMessage({
              jsonrpc: "2.0",
              id: message.id,
              error: {
                code: -32700,
                message: "Parse error"
              }
            });
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
  async#processMessage(message) {
    if ("method" in message && "id" in message) {
      const response = await this.#tryCallRequestHandler(message.method, message.params);
      if ("error" in response) {
        console.error("Error handling request", message, response.error);
      }
      await this.#sendMessage({
        jsonrpc: "2.0",
        id: message.id,
        ...response
      });
    } else if ("method" in message) {
      const response = await this.#tryCallNotificationHandler(message.method, message.params);
      if ("error" in response) {
        console.error("Error handling notification", message, response.error);
      }
    } else if ("id" in message) {
      this.#handleResponse(message);
    } else {
      console.error("Invalid message", { message });
    }
  }
  async#tryCallRequestHandler(method, params) {
    try {
      const result = await this.#requestHandler(method, params);
      return { result: result ?? null };
    } catch (error) {
      if (error instanceof RequestError) {
        return error.toResult();
      }
      if (error instanceof exports_external.ZodError) {
        return RequestError.invalidParams(error.format()).toResult();
      }
      let details;
      if (error instanceof Error) {
        details = error.message;
      } else if (typeof error === "object" && error != null && "message" in error && typeof error.message === "string") {
        details = error.message;
      }
      try {
        return RequestError.internalError(details ? JSON.parse(details) : {}).toResult();
      } catch (_err) {
        return RequestError.internalError({ details }).toResult();
      }
    }
  }
  async#tryCallNotificationHandler(method, params) {
    try {
      await this.#notificationHandler(method, params);
      return { result: null };
    } catch (error) {
      if (error instanceof RequestError) {
        return error.toResult();
      }
      if (error instanceof exports_external.ZodError) {
        return RequestError.invalidParams(error.format()).toResult();
      }
      let details;
      if (error instanceof Error) {
        details = error.message;
      } else if (typeof error === "object" && error != null && "message" in error && typeof error.message === "string") {
        details = error.message;
      }
      try {
        return RequestError.internalError(details ? JSON.parse(details) : {}).toResult();
      } catch (_err) {
        return RequestError.internalError({ details }).toResult();
      }
    }
  }
  #handleResponse(response) {
    const pendingResponse = this.#pendingResponses.get(response.id);
    if (pendingResponse) {
      if ("result" in response) {
        pendingResponse.resolve(response.result);
      } else if ("error" in response) {
        pendingResponse.reject(response.error);
      }
      this.#pendingResponses.delete(response.id);
    } else {
      console.error("Got response to unknown request", response.id);
    }
  }
  async sendRequest(method, params) {
    const id = this.#nextRequestId++;
    const responsePromise = new Promise((resolve, reject) => {
      this.#pendingResponses.set(id, { resolve, reject });
    });
    await this.#sendMessage({ jsonrpc: "2.0", id, method, params });
    return responsePromise;
  }
  async sendNotification(method, params) {
    await this.#sendMessage({ jsonrpc: "2.0", method, params });
  }
  async#sendMessage(message) {
    this.#writeQueue = this.#writeQueue.then(async () => {
      const writer = this.#stream.writable.getWriter();
      try {
        await writer.write(message);
      } finally {
        writer.releaseLock();
      }
    }).catch((error) => {
      console.error("ACP write error:", error);
    });
    return this.#writeQueue;
  }
}

class RequestError extends Error {
  code;
  data;
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.name = "RequestError";
    this.data = data;
  }
  static parseError(data) {
    return new RequestError(-32700, "Parse error", data);
  }
  static invalidRequest(data) {
    return new RequestError(-32600, "Invalid request", data);
  }
  static methodNotFound(method) {
    return new RequestError(-32601, "Method not found", { method });
  }
  static invalidParams(data) {
    return new RequestError(-32602, "Invalid params", data);
  }
  static internalError(data) {
    return new RequestError(-32603, "Internal error", data);
  }
  static authRequired(data) {
    return new RequestError(-32000, "Authentication required", data);
  }
  static resourceNotFound(uri) {
    return new RequestError(-32002, "Resource not found", uri && { uri });
  }
  toResult() {
    return {
      error: {
        code: this.code,
        message: this.message,
        data: this.data
      }
    };
  }
  toErrorResponse() {
    return {
      code: this.code,
      message: this.message,
      data: this.data
    };
  }
}

// src/proxy/acp/agent.ts
import { Readable, Writable } from "node:stream";
import { readFileSync as readFileSync2 } from "node:fs";

// src/proxy/drivers/claudePty/pty.ts
import { createRequire } from "node:module";
import { chmodSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
var require2 = createRequire(import.meta.url);
function loadPty() {
  try {
    const pkg = require2.resolve("node-pty/package.json");
    const helper = join(dirname(pkg), "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
    if (existsSync(helper))
      chmodSync(helper, 493);
  } catch {}
  return require2("node-pty");
}
function spawnClaude(opts) {
  const pty = loadPty();
  const p = pty.spawn(opts.claudePath, opts.args ?? [], {
    name: "xterm-256color",
    cols: opts.cols ?? 160,
    rows: opts.rows ?? 50,
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env, TERM: "xterm-256color" }
  });
  return {
    onData: (cb) => p.onData(cb),
    write: (d) => p.write(d),
    resize: (c, r) => p.resize(c, r),
    kill: () => p.kill(),
    onExit: (cb) => p.onExit(({ exitCode }) => cb(exitCode))
  };
}

// src/proxy/drivers/claudePty/titleState.ts
var OSC_TITLE = /\x1b\]0;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
function titleState(title) {
  const t = title.trim();
  if (t.length === 0)
    return "idle";
  const code = t.codePointAt(0);
  if (code === undefined)
    return "idle";
  return code >= 10240 && code <= 10495 ? "working" : "idle";
}
function lastTitle(chunk) {
  OSC_TITLE.lastIndex = 0;
  let last = null;
  let m;
  while ((m = OSC_TITLE.exec(chunk)) !== null) {
    if (m[1] !== undefined)
      last = m[1];
  }
  return last;
}

// src/proxy/drivers/claudePty/turnFsm.ts
function initTurn() {
  return { phase: "idle", sawWorking: false };
}
function reduceTurn(s, e) {
  switch (s.phase) {
    case "idle":
      return e.type === "send" ? { ...s, phase: "sent" } : s;
    case "sent":
      if (e.type === "title" && e.state === "working")
        return { phase: "working", sawWorking: true };
      if (e.type === "timeout")
        return { ...s, phase: "error" };
      return s;
    case "working":
      if (e.type === "title" && e.state === "idle")
        return { ...s, phase: "done" };
      return s;
    default:
      return s;
  }
}

// src/proxy/drivers/claudePty/extractText.ts
var CURSOR_FWD = /\x1b\[(\d*)C/g;
var ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;
function clean(s) {
  const spaced = s.replace(CURSOR_FWD, (_m, n) => " ".repeat(n ? parseInt(n, 10) : 1));
  return spaced.replace(ANSI, "");
}
var UI_BOUNDARY = /[✽✻✶✳✢✷✸✺✹❋✦⎿❯─]|\s·\s|\bTip:/u;
function extractAssistant(turnRaw) {
  const c = clean(turnRaw);
  const idx = c.lastIndexOf("⏺");
  if (idx === -1)
    return "";
  const tail = c.slice(idx + 1);
  const cut = tail.split(UI_BOUNDARY)[0] ?? "";
  return cut.replace(/\s+/g, " ").trim();
}

// src/proxy/drivers/claudePty/screen.ts
import { createRequire as createRequire2 } from "node:module";
var require3 = createRequire2(import.meta.url);
var { Terminal } = require3("@xterm/headless");
var INLINE_CODE_FG = 153;

class Screen {
  term;
  constructor(cols = 160, rows = 50, scrollback = 8000) {
    this.term = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
  }
  write(data) {
    this.term.write(data);
  }
  async rows() {
    await new Promise((resolve) => this.term.write("", () => resolve()));
    const buf = this.term.buffer.active;
    const out = [];
    for (let y = 0;y < buf.length; y++) {
      const line = buf.getLine(y);
      out.push(line ? line.translateToString(true) : "");
    }
    return out;
  }
  async styledRows() {
    await new Promise((resolve) => this.term.write("", () => resolve()));
    const buf = this.term.buffer.active;
    const reuse = buf.getNullCell();
    const out = [];
    for (let y = 0;y < buf.length; y++) {
      const line = buf.getLine(y);
      if (!line) {
        out.push([]);
        continue;
      }
      const spans = [];
      let cur = null;
      for (let x = 0;x < line.length; x++) {
        const c = line.getCell(x, reuse);
        if (!c)
          continue;
        const ch = c.getChars() || " ";
        const bold = !!c.isBold();
        const italic = !!c.isItalic();
        const underline = !!c.isUnderline();
        const isDefault = c.isFgDefault();
        const code = !isDefault && c.isFgPalette() && c.getFgColor() === INLINE_CODE_FG;
        const syntax = !isDefault && !code;
        if (cur && !!cur.bold === bold && !!cur.italic === italic && !!cur.underline === underline && !!cur.code === code && !!cur.syntax === syntax) {
          cur.text += ch;
        } else {
          cur = { text: ch, bold, italic, underline, code, syntax };
          spans.push(cur);
        }
      }
      out.push(spans);
    }
    return out;
  }
  resize(cols, rows) {
    this.term.resize(cols, rows);
  }
  dispose() {
    this.term.dispose();
  }
}

// src/proxy/drivers/claudePty/extractRows.ts
var BULLET = /^\s*⏺\s?/u;
var INPUT_BOX = /^\s*❯/u;
var SPINNER = /^\s*[✻✽✶✳✢✷✸✺✹❋✦]/u;
var STATUS_LINE = /^\s*·\s.*\(\d+[smh]\b/u;
var FOOTER = /^\s*(?:\[(?:Opus|Sonnet|Claude|Haiku)\b|(?:Context|Usage|Weekly)\s+[░▁▂▃▄▅▆▇█])/u;
var RULE_ONLY = /^[─\s]*$/u;
var LIST_ITEM = /^\s*(?:[-*+]\s|\d+[.)]\s)/u;
function ensureBlankBeforeLists(lines) {
  const out = [];
  for (const line of lines) {
    const prev = out[out.length - 1];
    if (LIST_ITEM.test(line) && prev !== undefined && prev.trim() !== "" && !LIST_ITEM.test(prev)) {
      out.push("");
    }
    out.push(line);
  }
  return out;
}
function isBoundary(row) {
  return INPUT_BOX.test(row) || SPINNER.test(row) || STATUS_LINE.test(row) || FOOTER.test(row);
}
var TOOL_RESULT_GLYPH = "⎿";
function looksLikeToolRender(text) {
  return text.includes(TOOL_RESULT_GLYPH);
}
function countBullets(rows) {
  let n = 0;
  for (const r of rows)
    if (BULLET.test(r))
      n++;
  return n;
}
function assistantRowRange(rows) {
  let start = -1;
  for (let i = rows.length - 1;i >= 0; i--) {
    if (BULLET.test(rows[i])) {
      start = i;
      break;
    }
  }
  if (start === -1)
    return null;
  let end = rows.length;
  for (let i = start + 1;i < rows.length; i++) {
    if (isBoundary(rows[i])) {
      end = i;
      break;
    }
  }
  return [start, end];
}
function extractAssistantFromRows(rows) {
  let start = -1;
  for (let i = rows.length - 1;i >= 0; i--) {
    if (BULLET.test(rows[i])) {
      start = i;
      break;
    }
  }
  if (start === -1)
    return "";
  const out = [];
  for (let i = start;i < rows.length; i++) {
    const row = rows[i];
    if (i > start && isBoundary(row))
      break;
    out.push(i === start ? row.replace(BULLET, "") : row.replace(/^ {1,2}/, ""));
  }
  while (out.length && RULE_ONLY.test(out[out.length - 1]))
    out.pop();
  while (out.length && out[0].trim() === "")
    out.shift();
  return ensureBlankBeforeLists(out).join(`
`).replace(/[ \t]+$/gm, "").trimEnd();
}

// src/proxy/drivers/claudePty/reconstruct.ts
var LIST_ITEM2 = /^(\s*)([-*•]|\d+[.)])\s+(.*)$/u;
var BOX_CHARS = /[┌┐└┘├┤┬┴┼─│╭╮╰╯]/u;
var TABLE_ROW = /^\s*[│┌├└]/u;
var BRACEISH = /^[\s{}()[\];,]+$/u;
function isCodeLine(row) {
  return row.some((s) => s.syntax && s.text.trim() !== "");
}
function isBraceish(text) {
  return text.trim() !== "" && BRACEISH.test(text);
}
function wrap(text, marker) {
  const m = text.match(/^(\s*)([\s\S]*?)(\s*)$/);
  if (!m || m[2] === "")
    return text;
  return m[1] + marker + m[2] + marker + m[3];
}
function mergeRuns(spans) {
  const out = [];
  for (const sp of spans) {
    const prev = out[out.length - 1];
    if (prev && !!prev.bold === !!sp.bold && !!prev.italic === !!sp.italic && !!prev.code === !!sp.code) {
      prev.text += sp.text;
    } else {
      out.push({ ...sp });
    }
  }
  return out;
}
function renderInline(spans, quote = false) {
  let out = "";
  for (const sp of mergeRuns(spans)) {
    if (sp.text === "")
      continue;
    const italic = sp.italic && !quote;
    if (sp.code)
      out += wrap(sp.text, "`");
    else if (sp.bold && italic)
      out += wrap(sp.text, "***");
    else if (sp.bold)
      out += wrap(sp.text, "**");
    else if (italic)
      out += wrap(sp.text, "*");
    else
      out += sp.text;
  }
  return out;
}
var plain = (spans) => spans.map((s) => s.text).join("");
function headingHashes(spans) {
  const meaningful = spans.filter((s) => s.text.trim() !== "");
  if (!meaningful.length || !meaningful.every((s) => s.bold))
    return null;
  return meaningful.some((s) => s.underline) ? "#" : "##";
}
function detectLanguage(code) {
  if (/<\/[a-z][\w-]*>|^\s*<(!doctype|html|head|body|div|span|ul|li|a)\b/im.test(code))
    return "html";
  if (/^\s*#include\b|\bstd::|\bcout\s*<</m.test(code))
    return "cpp";
  if (/\bfn\s+\w+|\blet\s+mut\b|\bimpl\s|\bprintln!|->\s*\w+\s*\{/.test(code))
    return "rust";
  if (/\bfunc\s+\w+|\bpackage\s+\w+\b|:=/.test(code))
    return "go";
  if (/\bpublic\s+(class|static)\b|\bSystem\.out\./.test(code))
    return "java";
  if (/\bdef\s+\w+\s*\(|^\s*(from|import)\s+\w|\bprint\s*\(|\bself\b/m.test(code))
    return "python";
  if (/\b(SELECT|INSERT\s+INTO|UPDATE|DELETE)\b/i.test(code) && /\b(FROM|INTO|SET)\b/i.test(code))
    return "sql";
  if (/^\s*#!.*\b(bash|sh|zsh)\b|^\s*(echo|cd|export|sudo|mkdir)\s/m.test(code))
    return "bash";
  if (/\binterface\s+\w+|:\s*(string|number|boolean|void)\b|\bimport\b[^\n]*\bfrom\b[^\n]*['"]/.test(code))
    return "typescript";
  if (/\b(function|const|let)\b|=>|\bconsole\.\w+/.test(code))
    return "javascript";
  if (/^\s*[{[][\s\S]*"[^"]+"\s*:/.test(code))
    return "json";
  return "";
}
var QUOTE_BAR = /^(\s*)[▎▏▌▐│┃]\s?/u;
function renderTable(rows) {
  const out = [];
  let headerDone = false;
  for (const row of rows) {
    const text = plain(row).trim();
    if (!text.includes("│"))
      continue;
    const cells = text.split("│").map((c) => c.trim());
    if (cells.length && cells[0] === "")
      cells.shift();
    if (cells.length && cells[cells.length - 1] === "")
      cells.pop();
    out.push("| " + cells.join(" | ") + " |");
    if (!headerDone) {
      out.push("| " + cells.map(() => "---").join(" | ") + " |");
      headerDone = true;
    }
  }
  return out.join(`
`);
}
function reconstructMarkdown(rows) {
  const lines = [];
  for (let i = 0;i < rows.length; i++) {
    const row = rows[i];
    const text = plain(row);
    if (isCodeLine(row)) {
      const code = [];
      while (i < rows.length) {
        const t = plain(rows[i]);
        const blankThenCode = t.trim() === "" && i + 1 < rows.length && (isCodeLine(rows[i + 1]) || isBraceish(plain(rows[i + 1])));
        if (isCodeLine(rows[i]) || isBraceish(t) || blankThenCode) {
          code.push(t.replace(/[ \t]+$/, ""));
          i++;
        } else
          break;
      }
      i--;
      while (code.length && code[code.length - 1].trim() === "")
        code.pop();
      const body = code.join(`
`);
      lines.push("```" + detectLanguage(body) + `
` + body + "\n```");
      continue;
    }
    const qm = text.match(QUOTE_BAR);
    if (qm) {
      lines.push("> " + renderInline(dropLeadingChars(row, qm[0].length), true));
      continue;
    }
    if (TABLE_ROW.test(text) && BOX_CHARS.test(text)) {
      const block = [];
      while (i < rows.length && BOX_CHARS.test(plain(rows[i])))
        block.push(rows[i++]);
      i--;
      lines.push(renderTable(block));
      continue;
    }
    const listMatch = text.match(LIST_ITEM2);
    if (listMatch) {
      const marker = /\d/.test(listMatch[2]) ? listMatch[2] : "-";
      const contentSpans = stripPrefix(row, listMatch[1].length + listMatch[2].length + 1);
      lines.push(`${listMatch[1]}${marker} ${renderInline(contentSpans)}`);
      continue;
    }
    const hashes = headingHashes(row);
    if (hashes) {
      lines.push(`${hashes} ${plain(row).trim()}`);
      continue;
    }
    lines.push(renderInline(row));
  }
  const trimmed = lines.map((l) => l.replace(/[ \t]+$/, ""));
  while (trimmed.length && trimmed[trimmed.length - 1].trim() === "")
    trimmed.pop();
  return trimmed.join(`
`);
}
function dropLeadingChars(spans, n) {
  return stripPrefix(spans, n);
}
function stripPrefix(spans, n) {
  const out = [];
  let dropped = 0;
  for (const sp of spans) {
    if (dropped >= n) {
      out.push(sp);
      continue;
    }
    const take = Math.min(n - dropped, sp.text.length);
    dropped += take;
    const rest = sp.text.slice(take);
    if (rest)
      out.push({ ...sp, text: rest });
  }
  return out;
}

// src/proxy/drivers/claudePty/streamCommit.ts
function initCommit() {
  return { committed: "" };
}
var BOX = /[│┌┐└┘├┤┬┴┼]/u;
function wholeLines(s) {
  const i = s.lastIndexOf(`
`);
  return i === -1 ? "" : s.slice(0, i + 1);
}
function firstBoxLineStart(s) {
  let lineStart = 0;
  for (let i = 0;i <= s.length; i++) {
    if (i === s.length || s[i] === `
`) {
      if (BOX.test(s.slice(lineStart, i)))
        return lineStart;
      lineStart = i + 1;
    }
  }
  return -1;
}
function commitStep(state, current) {
  let stable = wholeLines(current);
  const boxAt = firstBoxLineStart(stable);
  if (boxAt >= 0)
    stable = stable.slice(0, boxAt);
  if (stable.length > state.committed.length && stable.startsWith(state.committed)) {
    const delta = stable.slice(state.committed.length);
    state.committed = stable;
    return delta;
  }
  return "";
}
function commitFlush(state, final) {
  if (final.startsWith(state.committed)) {
    const delta = final.slice(state.committed.length);
    state.committed = final;
    return delta;
  }
  return "";
}

// src/proxy/drivers/claudePty/transcriptTail.ts
import { readdirSync, existsSync as existsSync2, readFileSync, statSync } from "node:fs";
import { join as join2 } from "node:path";
import { homedir } from "node:os";

// src/proxy/drivers/claudePty/transcript.ts
function isTerminalStop(reason) {
  return typeof reason === "string" && reason !== "" && reason !== "tool_use" && reason !== "pause_turn";
}
function isObj(v) {
  return typeof v === "object" && v !== null;
}
function str(v) {
  return typeof v === "string" ? v : "";
}
function toolResultText(content) {
  if (typeof content === "string")
    return content;
  if (Array.isArray(content))
    return content.map((b) => isObj(b) ? str(b.text) : "").join("");
  return "";
}
function parseTranscriptLine(line) {
  let rec;
  try {
    rec = JSON.parse(line);
  } catch {
    return [];
  }
  if (!isObj(rec) || !isObj(rec.message))
    return [];
  const msg = rec.message;
  const content = msg.content;
  if (!Array.isArray(content))
    return [];
  const out = [];
  for (const b of content) {
    if (!isObj(b))
      continue;
    switch (b.type) {
      case "text":
        out.push({ kind: "text", text: str(b.text) });
        break;
      case "thinking":
        out.push({ kind: "thinking", text: str(b.thinking) });
        break;
      case "tool_use":
        out.push({ kind: "tool_use", id: str(b.id), name: str(b.name), input: b.input });
        break;
      case "tool_result":
        out.push({ kind: "tool_result", toolUseId: str(b.tool_use_id), text: toolResultText(b.content) });
        break;
    }
  }
  if (msg.role === "assistant" && isTerminalStop(msg.stop_reason)) {
    out.push({ kind: "turn_end", reason: msg.stop_reason });
  }
  return out;
}

// src/proxy/drivers/claudePty/transcriptTail.ts
var DEFAULT_PROJECTS = join2(homedir(), ".claude", "projects");
function findSessionFile(sessionId, projectsDir = DEFAULT_PROJECTS) {
  const target = `${sessionId}.jsonl`;
  let dirs;
  try {
    dirs = readdirSync(projectsDir);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const fp = join2(projectsDir, d, target);
    if (existsSync2(fp))
      return fp;
  }
  return null;
}

class TranscriptTail {
  sessionId;
  projectsDir;
  file = null;
  linesConsumed = 0;
  lastSize = -1;
  cachedLines = [];
  constructor(sessionId, projectsDir = DEFAULT_PROJECTS) {
    this.sessionId = sessionId;
    this.projectsDir = projectsDir;
  }
  located() {
    if (this.file)
      return true;
    this.file = findSessionFile(this.sessionId, this.projectsDir);
    return this.file !== null;
  }
  markBaseline() {
    this.linesConsumed = this.lines().length;
  }
  read() {
    const lines = this.lines();
    if (lines.length <= this.linesConsumed)
      return [];
    const fresh = lines.slice(this.linesConsumed);
    this.linesConsumed = lines.length;
    return fresh.flatMap(parseTranscriptLine);
  }
  lines() {
    if (!this.located() || !this.file)
      return [];
    let size;
    try {
      size = statSync(this.file).size;
    } catch {
      return this.cachedLines;
    }
    if (size === this.lastSize)
      return this.cachedLines;
    try {
      this.cachedLines = readFileSync(this.file, "utf8").split(`
`).filter(Boolean);
      this.lastSize = size;
    } catch {}
    return this.cachedLines;
  }
}

// src/proxy/drivers/claudePty/permissionDialog.ts
var FOOTER2 = /Esc to cancel/;
var OPTION_G = /(❯)?\s*\b(\d+)\.\s+([^\n❯]*?)(?=\s{2,}|\n|$)/g;
var DEFAULT_MARK = /❯\s*(\d+)\./;
function parsePermission(screen) {
  if (!FOOTER2.test(screen))
    return null;
  const options = [];
  const seen = new Set;
  OPTION_G.lastIndex = 0;
  let m;
  while ((m = OPTION_G.exec(screen)) !== null) {
    const num = Number(m[2]);
    if (!Number.isFinite(num) || seen.has(num))
      continue;
    seen.add(num);
    options.push({ index: num - 1, name: (m[3] ?? "").trim() });
  }
  if (options.length < 2)
    return null;
  const dm = DEFAULT_MARK.exec(screen);
  const defaultIndex = dm && dm[1] !== undefined ? Number(dm[1]) - 1 : 0;
  return { options, defaultIndex };
}

// src/proxy/drivers/claudePty/session.ts
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
var DUMP_PATH = process.env.CLAUDE_PTY_DUMP;
var DEBUG = !!process.env.CLAUDE_PTY_DEBUG;
var SILENCE_LIMIT_MS = 300000;
var TURN_FAILSAFE_MS = 1800000;
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class ClaudeSession {
  pty;
  raw = "";
  screen = new Screen;
  sessionId;
  resuming;
  tail;
  mode;
  state = "idle";
  spawnAt = Date.now();
  lastByteAt = Date.now();
  exited = false;
  answeredSig = "";
  lastAnswerAt = 0;
  preTurnBullets = 0;
  constructor(claudePath, cwd, args = [], opts) {
    const envMode = process.env.CLAUDE_PTY_OUTPUT_MODE;
    const validEnv = envMode === "pty" || envMode === "preview" || envMode === "rich";
    this.mode = opts?.mode ?? (validEnv ? envMode : "clean");
    this.resuming = !!opts?.resumeSessionId;
    this.sessionId = opts?.resumeSessionId ?? randomUUID();
    this.tail = new TranscriptTail(this.sessionId);
    const idArgs = this.resuming ? ["--resume", this.sessionId] : ["--session-id", this.sessionId];
    this.pty = spawnClaude({ claudePath, cwd, args: [...idArgs, ...args] });
    this.pty.onExit(() => this.exited = true);
    this.pty.onData((chunk) => {
      this.raw += chunk;
      this.screen.write(chunk);
      this.lastByteAt = Date.now();
      if (DUMP_PATH) {
        try {
          appendFileSync(DUMP_PATH, chunk);
        } catch {}
      }
      const t = lastTitle(chunk);
      if (t !== null) {
        const next = titleState(t);
        if (DEBUG && next !== this.state) {
          process.stderr.write(`[dbg ${Date.now() - this.spawnAt}ms] title ${this.state}->${next} ${JSON.stringify(t.slice(0, 24))}
`);
        }
        this.state = next;
      }
    });
  }
  get id() {
    return this.sessionId;
  }
  async assistantText() {
    const rows = await this.screen.rows();
    if (countBullets(rows) <= this.preTurnBullets)
      return "";
    return extractAssistantFromRows(rows);
  }
  async richText() {
    const styled = await this.screen.styledRows();
    const plainRows = styled.map((r) => r.map((s) => s.text).join(""));
    if (countBullets(plainRows) <= this.preTurnBullets)
      return "";
    const range = assistantRowRange(plainRows);
    if (!range)
      return "";
    const [start, end] = range;
    const slice = [];
    for (let i = start;i < end; i++) {
      const m = i === start ? plainRows[i].match(/^\s*⏺\s?/) : plainRows[i].match(/^ {1,2}/);
      slice.push(dropLeadingChars(styled[i], m ? m[0].length : 0));
    }
    const ruleOrBlank = (r) => /^[─\s]*$/u.test(r.map((s) => s.text).join(""));
    while (slice.length && ruleOrBlank(slice[slice.length - 1]))
      slice.pop();
    return reconstructMarkdown(slice);
  }
  async waitFor(pred, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (pred())
        return true;
      if (this.exited)
        return pred();
      await sleep(40);
    }
    return pred();
  }
  async ready() {
    if (this.resuming) {
      if (await this.waitFor(() => /trust this folder/i.test(this.raw), 4000)) {
        await sleep(600);
        this.pty.write("\r");
      }
      return this.waitFor(() => this.state === "idle" && Date.now() - this.spawnAt > 3000 && Date.now() - this.lastByteAt > 1500, 40000);
    }
    await this.waitFor(() => /trust this folder/i.test(this.raw), 15000);
    await sleep(600);
    this.pty.write("\r");
    return this.waitFor(() => this.state === "idle" && Date.now() - this.spawnAt > 4500 && Date.now() - this.lastByteAt > 1200 && this.raw.includes("Claude Code"), 40000);
  }
  handlePermission(startOff, onPermission) {
    if (!onPermission)
      return false;
    const recent = clean(this.raw.slice(startOff)).slice(-800);
    const dlg = parsePermission(recent);
    if (!dlg)
      return false;
    const sig = dlg.options.map((o) => o.name).join("|");
    if (sig !== this.answeredSig) {
      this.answeredSig = sig;
      this.lastAnswerAt = Date.now();
      onPermission(dlg).then((choice) => this.pty.write(String(choice + 1) + "\r"));
    }
    return true;
  }
  settled(quietMs, blocking) {
    const justAnswered = Date.now() - this.lastAnswerAt < 1500;
    return this.state === "idle" && !blocking && !justAnswered && Date.now() - this.lastByteAt > quietMs;
  }
  async turn(prompt, onUpdate, onPermission) {
    const t0 = Date.now();
    const startOff = this.raw.length;
    this.answeredSig = "";
    this.preTurnBullets = countBullets(await this.screen.rows());
    if (this.mode !== "pty")
      this.tail.markBaseline();
    let fsm = reduceTurn(initTurn(), { type: "send" });
    this.pty.write(prompt);
    await sleep(200);
    this.pty.write("\r");
    await this.waitFor(() => {
      if (this.state === "working")
        fsm = reduceTurn(fsm, { type: "title", state: "working" });
      return fsm.phase === "working";
    }, 20000);
    if (fsm.phase !== "working")
      fsm = reduceTurn(fsm, { type: "timeout" });
    const streamingPty = this.mode === "pty" || this.mode === "rich";
    const text = streamingPty ? await this.runPty(t0, startOff, () => fsm, (f) => fsm = f, onUpdate, onPermission) : await this.runClean(t0, startOff, () => fsm, (f) => fsm = f, onUpdate, onPermission);
    return {
      text,
      startedDetected: fsm.sawWorking,
      doneDetected: fsm.phase === "done",
      latencyMs: Date.now() - t0
    };
  }
  async runClean(t0, startOff, getFsm, setFsm, onUpdate, onPermission) {
    let fullText = "";
    let turnEnded = false;
    const emit = (events) => {
      for (const ev of events) {
        if (ev.kind === "text" && ev.text.trim()) {
          const delta = (fullText ? `

` : "") + ev.text;
          fullText += delta;
          onUpdate?.({ type: "text", delta, text: fullText });
        } else if (ev.kind === "tool_use") {
          onUpdate?.({ type: "tool_use", id: ev.id, name: ev.name, input: ev.input });
        } else if (ev.kind === "tool_result") {
          onUpdate?.({ type: "tool_result", id: ev.toolUseId, output: ev.text });
        } else if (ev.kind === "thinking" && ev.text.trim() && this.mode !== "preview") {
          onUpdate?.({ type: "thought", delta: ev.text });
        } else if (ev.kind === "turn_end") {
          turnEnded = true;
        }
      }
    };
    let previewEmitted = "";
    const streamPreview = async () => {
      if (this.mode !== "preview" || !onUpdate)
        return;
      const preview = await this.assistantText();
      if (preview.length > previewEmitted.length && preview.startsWith(previewEmitted)) {
        const delta = preview.slice(previewEmitted.length);
        previewEmitted = preview;
        onUpdate({ type: "thought", delta });
      } else if (!preview.startsWith(previewEmitted)) {
        previewEmitted = preview;
      }
    };
    if (getFsm().phase === "working") {
      const failsafe = Date.now() + TURN_FAILSAFE_MS;
      while (getFsm().phase !== "done" && Date.now() < failsafe) {
        const blocking = this.handlePermission(startOff, onPermission);
        await streamPreview();
        emit(this.tail.read());
        if (turnEnded || !this.tail.located() && this.settled(900, blocking)) {
          if (DEBUG)
            process.stderr.write(`[dbg ${Date.now() - t0}ms] CLEAN done (turnEnd=${turnEnded}) textLen=${fullText.length}
`);
          setFsm(reduceTurn(getFsm(), { type: "title", state: "idle" }));
        }
        if (this.exited || Date.now() - this.lastByteAt > SILENCE_LIMIT_MS)
          break;
        await sleep(50);
      }
    }
    const graceEnd = Date.now() + 2500;
    let quietSince = Date.now();
    while (Date.now() < graceEnd && Date.now() - quietSince < 600) {
      const events = this.tail.read();
      if (events.length) {
        emit(events);
        quietSince = Date.now();
      }
      await sleep(80);
    }
    if (!fullText.trim()) {
      const fallback = await this.assistantText() || extractAssistant(this.raw.slice(startOff));
      if (fallback.trim()) {
        fullText = fallback;
        onUpdate?.({ type: "text", delta: fallback, text: fullText });
      }
    }
    return fullText;
  }
  async runPty(t0, startOff, getFsm, setFsm, onUpdate, onPermission) {
    const rich = this.mode === "rich";
    const getText = () => rich ? this.richText() : this.assistantText();
    const commit = initCommit();
    let lastLen = 0;
    let lastGrowAt = Date.now();
    if (getFsm().phase === "working") {
      const failsafe = Date.now() + TURN_FAILSAFE_MS;
      while (getFsm().phase !== "done" && Date.now() < failsafe) {
        const blocking = this.handlePermission(startOff, onPermission);
        if (rich && onUpdate)
          this.emitToolEvents(this.tail.read(), onUpdate, commit);
        const current = await getText();
        if (current.length > lastLen) {
          lastLen = current.length;
          lastGrowAt = Date.now();
        }
        if (onUpdate && !(rich && looksLikeToolRender(current))) {
          const delta = commitStep(commit, current);
          if (delta)
            onUpdate({ type: "text", delta, text: commit.committed });
        }
        const justAnswered = Date.now() - this.lastAnswerAt < 1500;
        const settled = Date.now() - lastGrowAt > 900;
        if (this.state === "idle" && !blocking && !justAnswered && settled) {
          setFsm(reduceTurn(getFsm(), { type: "title", state: "idle" }));
        }
        if (this.exited || Date.now() - this.lastByteAt > SILENCE_LIMIT_MS)
          break;
        await sleep(40);
      }
    }
    if (rich && onUpdate)
      this.emitToolEvents(this.tail.read(), onUpdate, commit);
    let text = await getText();
    if (rich && looksLikeToolRender(text))
      text = commit.committed;
    else if (!text)
      text = commit.committed || extractAssistant(this.raw.slice(startOff));
    if (onUpdate) {
      const delta = commitFlush(commit, text);
      if (delta)
        onUpdate({ type: "text", delta, text: commit.committed });
    }
    return text;
  }
  emitToolEvents(events, onUpdate, commit) {
    for (const ev of events) {
      if (ev.kind === "tool_use") {
        onUpdate({ type: "tool_use", id: ev.id, name: ev.name, input: ev.input });
        commit.committed = "";
      } else if (ev.kind === "tool_result") {
        onUpdate({ type: "tool_result", id: ev.toolUseId, output: ev.text });
      } else if (ev.kind === "thinking" && ev.text.trim()) {
        onUpdate({ type: "thought", delta: ev.text });
      }
    }
  }
  cancel() {
    this.pty.write("\x1B");
  }
  async close() {
    try {
      this.pty.write("\x03");
      await sleep(150);
      this.pty.write("/exit\r");
      await sleep(400);
    } finally {
      this.pty.kill();
    }
  }
}

// src/proxy/acp/types.ts
function textFromPrompt(blocks) {
  return blocks.map((b) => b.type === "text" ? b.text : "").filter((s) => s.length > 0).join(`
`);
}
function toStopReason(done) {
  return done ? "end_turn" : "cancelled";
}

// src/proxy/acp/agent.ts
var SESSION_ARGS = ["--settings", '{"remoteControlAtStartup":false}'];
var SYSTEM_TAG = /^<(local-command-(caveat|stdout)|command-(name|message|args|contents|stdout)|task-notification|system-reminder)\b/;
var TOOL_KIND = {
  Bash: "execute",
  Read: "read",
  Edit: "edit",
  Write: "edit",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  Grep: "search",
  Glob: "search",
  WebFetch: "fetch",
  WebSearch: "fetch"
};
function asRecord(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? v : undefined;
}
function toolTitle(name, input) {
  const r = asRecord(input);
  if (r) {
    for (const key of ["command", "file_path", "path", "pattern", "url", "query", "description"]) {
      const v = r[key];
      if (typeof v === "string" && v.trim())
        return v;
    }
  }
  return name;
}
function toAcpUpdate(e) {
  if (e.type === "text") {
    return { sessionUpdate: "agent_message_chunk", content: { type: "text", text: e.delta } };
  }
  if (e.type === "thought") {
    return { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: e.delta } };
  }
  if (e.type === "tool_result") {
    return {
      sessionUpdate: "tool_call_update",
      toolCallId: e.id,
      status: "completed",
      content: e.output.trim() ? [{ type: "content", content: { type: "text", text: e.output } }] : undefined
    };
  }
  return {
    sessionUpdate: "tool_call",
    toolCallId: e.id || `tool-${e.name}`,
    title: toolTitle(e.name, e.input),
    kind: TOOL_KIND[e.name] ?? "other",
    rawInput: asRecord(e.input),
    status: "in_progress"
  };
}
function toTurnEvent(ev) {
  switch (ev.kind) {
    case "text":
      return ev.text.trim() ? { type: "text", delta: ev.text, text: ev.text } : null;
    case "thinking":
      return ev.text.trim() ? { type: "thought", delta: ev.text } : null;
    case "tool_use":
      return { type: "tool_use", id: ev.id, name: ev.name, input: ev.input };
    case "tool_result":
      return { type: "tool_result", id: ev.toolUseId, output: ev.text };
    case "turn_end":
      return null;
  }
}

class ClaudePtyAgent {
  conn;
  claudePath;
  sessions = new Map;
  constructor(conn, claudePath) {
    this.conn = conn;
    this.claudePath = claudePath;
  }
  async initialize(params) {
    return {
      protocolVersion: params.protocolVersion ?? PROTOCOL_VERSION,
      agentCapabilities: { loadSession: true }
    };
  }
  async authenticate(_params) {}
  async newSession(params) {
    const driver = new ClaudeSession(this.claudePath, params.cwd, SESSION_ARGS);
    await driver.ready();
    this.sessions.set(driver.id, driver);
    return { sessionId: driver.id };
  }
  async loadSession(params) {
    const file = findSessionFile(params.sessionId);
    if (file)
      this.replayHistory(params.sessionId, file);
    const driver = new ClaudeSession(this.claudePath, params.cwd, SESSION_ARGS, {
      resumeSessionId: params.sessionId
    });
    await driver.ready();
    this.sessions.set(params.sessionId, driver);
    return {};
  }
  replayHistory(sessionId, file) {
    let lines;
    try {
      lines = readFileSync2(file, "utf8").split(`
`).filter(Boolean);
    } catch {
      return;
    }
    for (const line of lines) {
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const top = rec !== null && typeof rec === "object" ? rec : {};
      const msg = top.message;
      const role = msg !== null && typeof msg === "object" ? msg.role : undefined;
      const content = msg !== null && typeof msg === "object" ? msg.content : undefined;
      const injected = top.isMeta === true || top.isCompactSummary === true;
      if (role === "user" && typeof content === "string" && content.trim() && !injected && !SYSTEM_TAG.test(content.trimStart())) {
        this.send(sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: content } });
        continue;
      }
      for (const ev of parseTranscriptLine(line)) {
        const te = toTurnEvent(ev);
        if (te)
          this.send(sessionId, toAcpUpdate(te));
      }
    }
  }
  async prompt(params) {
    const driver = this.sessions.get(params.sessionId);
    if (!driver)
      return { stopReason: "refusal" };
    const r = await driver.turn(textFromPrompt(params.prompt), (e) => this.send(params.sessionId, toAcpUpdate(e)), async (p) => p.defaultIndex);
    return { stopReason: toStopReason(r.doneDetected) };
  }
  async cancel(params) {
    this.sessions.get(params.sessionId)?.cancel();
  }
  send(sessionId, update) {
    this.conn.sessionUpdate({ sessionId, update });
  }
}
function serveStdio(claudePath) {
  const input = Readable.toWeb(process.stdin);
  const output = Writable.toWeb(process.stdout);
  new AgentSideConnection((conn) => new ClaudePtyAgent(conn, claudePath), ndJsonStream(output, input));
}

// spike/sp1/acp_agent.ts
import { homedir as homedir2 } from "node:os";
import { join as join3 } from "node:path";
serveStdio(process.env.CLAUDE_PATH || join3(homedir2(), ".local/bin/claude"));
