import { JSONMetaSchema } from "@json-schema-tools/meta-schema";
import traverse from "@json-schema-tools/traverse";
import * as fs from "fs";
import fetch from "node-fetch";
import Ptr from "@json-schema-spec/json-pointer";
import * as path from "path";

const fileExistsAndReadable = (f: string): Promise<boolean> => {
  return new Promise((resolve) => {
    fs.access(f, fs.constants.F_OK | fs.constants.R_OK, (e) => { //tslint:disable-line
      if (e) { return resolve(false); }
      resolve(true);
    });
  });
};
const readFile = (f: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    fs.readFile(f, "utf8", (err, data) => {
      if (err) {
        return reject(err);
      }
      return resolve(data);
    });
  });
};

export interface RefCache { [k: string]: JSONMetaSchema; }

/**
 * Options that can be passed to the derefencer constructor.
 */
export interface DereferencerOptions {
  /**
   * If true, resolved non-local references will also be dereferenced using the same options.
   */
  recursive?: boolean;
}

export const defaultDereferencerOptions: DereferencerOptions = {
  recursive: true,
};

/**
 * Error thrown by the constructor when given a ref that isn't a string
 *
 *
 * @example
 * ```typescript
 *
 * import Dereferencer, { NonStringRefError } from "@json-schema-tools/dereferencer";
 *
 * try { const dereffer = new Dereferencer({}); }
 * catch(e) {
 *   if (e instanceof NonStringRefError) { ... }
 * }
 * ```
 *
 */
export class NonStringRefError extends Error {
  constructor(schema: JSONMetaSchema) {
    let schemaString = "";
    try {
      schemaString = JSON.stringify(schema);
    } catch (e) {
      schemaString = [
        `Keys: ${Object.keys(schema)}`,
        `Respective Values: ${Object.values(schema)}`,
      ].join("\n");
    }
    super(
      [
        "NonStringRefError",
        "Found an improperly formatted $ref in schema. $ref must be a string",
        `schema in question: ${schemaString}`,
      ].join("\n"),
    );
  }
}

/**
 * Error thrown when the fetched reference is not properly formatted JSON or is encoded
 * incorrectly
 *
 * @example
 * ```typescript
 *
 * import Dereferencer, { NonJsonRefError } from "@json-schema-tools/dereferencer";
 * const dereffer = new Dereferencer({});
 * try { await dereffer.resolve(); }
 * catch(e) {
 *   if (e instanceof NonJsonRefError) { ... }
 * }
 * ```
 *
 */
export class NonJsonRefError extends Error {
  constructor(schema: JSONMetaSchema, nonJson: string) {
    super(
      [
        "NonJsonRefError",
        `The resolved value at the reference: ${schema.$ref} was not JSON.parse 'able`,
        `The non-json content in question: ${nonJson}`,
      ].join("\n"),
    );
  }
}

/**
 * Error thrown when a JSON pointer is provided but is not parseable as per the RFC6901
 *
 * @example
 * ```typescript
 *
 * import Dereferencer, { InvalidJsonPointerRefError } from "@json-schema-tools/dereferencer";
 * const dereffer = new Dereferencer({});
 * try { await dereffer.resolve(); }
 * catch(e) {
 *   if (e instanceof InvalidJsonPointerRefError) { ... }
 * }
 * ```
 *
 */
export class InvalidJsonPointerRefError extends Error {
  constructor(schema: JSONMetaSchema) {
    super(
      [
        "InvalidJsonPointerRefError",
        `The provided RFC6901 JSON Pointer is invalid: ${schema.$ref}`,
      ].join("\n"),
    );
  }
}

/**
 * Error thrown when given an invalid file system path as a reference.
 *
 * @example
 * ```typescript
 *
 * import Dereferencer, { InvalidFileSystemPathError } from "@json-schema-tools/dereferencer";
 * const dereffer = new Dereferencer({});
 * try { await dereffer.resolve(); }
 * catch(e) {
 *   if (e instanceof InvalidFileSystemPathError) { ... }
 * }
 * ```
 *
 */
export class InvalidFileSystemPathError extends Error {
  constructor(ref: string) {
    super(
      [
        "InvalidFileSystemPathError",
        `The path was not resolvable: ${ref}`,
        `resolved path: ${path.resolve(process.cwd(), ref)}`,
      ].join("\n"),
    );
  }
}

/**
 * Error thrown when given an invalid file system path as a reference.
 *
 */
export class InvalidRemoteURLError extends Error {
  constructor(ref: string) {
    super(
      [
        "InvalidRemoteURLError",
        `The url was not resolvable: ${ref}`,
      ].join("\n"),
    );
  }
}

/**
 * When instantiated, represents a fully configured dereferencer. When constructed, references are pulled out.
 * No references are fetched until .resolve is called.
 */
export class Dereferencer {

  public refs: string[];
  private refCache: RefCache = {};
  private schema: JSONMetaSchema;

  constructor(schema: JSONMetaSchema, private options: DereferencerOptions = defaultDereferencerOptions) {
    // this.schema = { ...schema }; // start by making a shallow copy.
    this.schema = schema; // shallow copy breaks recursive
    this.refs = this.collectRefs();
    console.log("refs collected: ", this.refs); // tslint:disable-line
  }

  /**
   * Fetches the schemas for all the refs in the configured input schema(s)
   *
   * @returns a promise that will resolve a fully dereferenced schema, where all the
   *          promises for each ref has been resolved as well.
   *
   *
   */
  public async resolve(): Promise<JSONMetaSchema> {
    const refMap: { [s: string]: JSONMetaSchema } = {};

    if (this.refs.length === 0) { return Promise.resolve(this.schema); }

    for (const ref of this.refs) {
      console.log('resolve:: fetching Ref'); // tslint:disable-line
      const fetched = await this.fetchRef(ref);

      console.log('resolve:: finished fetching refs'); // tslint:disable-line
      if (this.options.recursive === true && ref[0] !== "#") {
        // might want to reconsider the class interface... lol

        console.log('creating new dereffer'); // tslint:disable-line
        const subDereffer = new Dereferencer(fetched, this.options);
        console.log('finished resolving subrefs'); // tslint:disable-line
        refMap[ref] = await subDereffer.resolve();
      } else {
        refMap[ref] = fetched;
      }
    }

    console.log('replacing references with refMap:', refMap); // tslint:disable-line

    // replace refs with their recurivesly resolved counterparts
    // fails when the root is replaced, ends up having no effect. so handle that case first.
    if (this.schema.$ref !== undefined) {
      this.schema = refMap[this.schema.$ref];
    } else {
      traverse(this.schema, (s) => {
        if (s.$ref !== undefined) {
          return refMap[s.$ref];
        }
        return s;
      }, { mutable: true });
      // might be able to get away iwth something like:
      // this.schema = traverse(this.schema, (s) => {
      //   if (s.$ref !== undefined) {
      //     return refMap[s.$ref];
      //   }
      //   return s;
      // }, { mutable: true });
      //  /// allthough this really depends on mutability of incoming schema...
    }

    console.log('replaced references', this.schema); // tslint:disable-line

    if (this.options.recursive === true) {
      this.refs = this.collectRefs();

      return this.resolve();
    } else {
      return this.schema;
    }
  }

  public async fetchRef(ref: string): Promise<JSONMetaSchema> {
    if (this.refCache[ref] !== undefined) {
      return this.refCache[ref];
    }

    if (ref[0] === "#") {
      const withoutHash = ref.replace("#", "");
      try {
        const pointer = Ptr.parse(withoutHash);
        const reffedSchema = pointer.eval(this.schema);

        // if (reffedSchema.$ref !== undefined) {
        //   const subFetched = await this.fetchRef(reffedSchema.$ref);
        //   this.refCache[ref] = reffedSchema;
        //   return subFetched;
        // }

        this.refCache[ref] = reffedSchema;
        return Promise.resolve(reffedSchema);
      } catch (e) {
        throw new InvalidJsonPointerRefError({ $ref: ref });
      }
    }

    // handle file references

    if (await fileExistsAndReadable(ref) === true) {
      console.log("fetchRef:: reading file"); // tslint:disable-line
      const fileContents = await readFile(ref);
      let reffedSchema;
      try {
        reffedSchema = JSON.parse(fileContents);
      } catch (e) {
        throw new NonJsonRefError({ $ref: ref }, fileContents);
      }

      // throw if not valid json schema
      // (todo when we have validator)

      // return it
      this.refCache[ref] = await reffedSchema;

      console.log("fetchRef:: finished reading file"); // tslint:disable-line
      return reffedSchema;
    } else if (["$", ".", "/"].indexOf(ref[0]) !== -1) {
      // there is good reason to assume this was intended to be a file path, but it was
      // not resolvable. In this case we should give a good error message.
      throw new InvalidFileSystemPathError(ref);
    }

    // handle http/https uri references
    // this forms the base case. We use node-fetch (or injected fetch lib) and let r rip
    let rs;
    console.log("fetchRef:: fetching url"); // tslint:disable-line
    try {
      rs = fetch(ref).then((r) => r.json());
    } catch (e) {
      console.error("Unable to fetch ref");
      throw new InvalidRemoteURLError(ref);
    }
    console.log(`fetchRef:: finished fetching url: ${ref}`); //tslint:disable-line

    this.refCache[ref] = await rs;

    return rs;
  }

  /**
   * First-pass traversal to collect all the refs that we can find. This allows us to
   * optimize the async work required as well.
   */
  public collectRefs(): string[] {
    const refs: string[] = [];

    traverse(this.schema, (s) => {
      if (s.$ref && refs.indexOf(s.$ref) === -1) {
        if (typeof s.$ref !== "string") {
          throw new NonStringRefError(s);
        }

        refs.push(s.$ref);
      }
      return s;
    });

    return refs;
  }
}

export default Dereferencer;
