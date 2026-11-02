// The parts of the Cooklang parser (@cooklang/cooklang) that cooklang.js
// uses, for the type check. Not loaded by the site.
export declare class Parser {
  load_units: boolean;
  parse(src: string, scale: number): any;
  group_ingredients(result: any): any[];
}
export declare function ingredient_should_be_listed(ingredient: any): boolean;
export declare function __wbg_set_wasm(exports: any): void;
