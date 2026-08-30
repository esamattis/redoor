import hljs from "highlight.js/lib/core";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import lua from "highlight.js/lib/languages/lua";
import markdown from "highlight.js/lib/languages/markdown";
import perl from "highlight.js/lib/languages/perl";
import plaintext from "highlight.js/lib/languages/plaintext";
import properties from "highlight.js/lib/languages/properties";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import shell from "highlight.js/lib/languages/shell";
import toml from "highlight.js/lib/languages/ini";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import type { SupportedSyntaxLanguage } from "#ui/utils/editor-language";

export const HIGHLIGHT_LANGUAGE_NAMES = {
    cpp: "cpp",
    csharp: "csharp",
    css: "css",
    go: "go",
    html: "xml",
    java: "java",
    javascript: "javascript",
    json: "json",
    lua: "lua",
    markdown: "markdown",
    perl: "perl",
    plaintext: "plaintext",
    properties: "properties",
    python: "python",
    ruby: "ruby",
    rust: "rust",
    shell: "shell",
    toml: "toml",
    typescript: "typescript",
    xml: "xml",
    yaml: "yaml",
} satisfies Record<SupportedSyntaxLanguage | "plaintext", string>;

hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("csharp", csharp);
hljs.registerLanguage("css", css);
hljs.registerLanguage("go", go);
hljs.registerLanguage("java", java);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("lua", lua);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("perl", perl);
hljs.registerLanguage("plaintext", plaintext);
hljs.registerLanguage("properties", properties);
hljs.registerLanguage("python", python);
hljs.registerLanguage("ruby", ruby);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("shell", shell);
hljs.registerLanguage("toml", toml);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);

export const syntaxHighlighter = hljs;
