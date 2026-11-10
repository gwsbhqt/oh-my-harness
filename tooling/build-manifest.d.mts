export type BuildDeclaration = {manifest:string;inputs:string[];outputs:string[];repositoryInputs?:string[]};
export type BuildStamp = {schemaVersion:1;algorithm:'sha256';inputs:Record<string,string>;outputs:Record<string,string>;repositoryInputs?:Record<string,string>};
export function snapshotInputs(dir:string,declaration:BuildDeclaration):Promise<Record<string,string>>;
export function snapshotInputState(dir:string,declaration:BuildDeclaration):Promise<{inputs:Record<string,string>;repositoryInputs:Record<string,string>}>;
export function snapshotBuild(dir:string,declaration:BuildDeclaration):Promise<BuildStamp>;
export function inspectBuild(dir:string,declaration?:BuildDeclaration,requiredOutputs?:string[]):Promise<{ok:boolean;status:'verified'|'stale'|'unverified';message:string;differenceCount?:number}>;
