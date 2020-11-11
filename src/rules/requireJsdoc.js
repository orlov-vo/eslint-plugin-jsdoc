import _ from 'lodash';
import {
  getJSDocComment, getReducedASTNode, getDecorator,
} from '../eslint/getJSDocComment';
import exportParser from '../exportParser';
import {
  getSettings,
} from '../iterateJsdoc';
import jsdocUtils from '../jsdocUtils';

const OPTIONS_SCHEMA = {
  additionalProperties: false,
  properties: {
    checkConstructors: {
      default: true,
      type: 'boolean',
    },
    checkGetters: {
      default: true,
      type: 'boolean',
    },
    checkSetters: {
      default: true,
      type: 'boolean',
    },
    contexts: {
      items: {
        anyOf: [
          {
            type: 'string',
          },
          {
            additionalProperties: false,
            properties: {
              context: {
                type: 'string',
              },
              inlineCommentBlock: {
                type: 'boolean',
              },
            },
            type: 'object',
          },
        ],
      },
      type: 'array',
    },
    enableFixer: {
      default: true,
      type: 'boolean',
    },
    exemptEmptyConstructors: {
      default: false,
      type: 'boolean',
    },
    exemptEmptyFunctions: {
      default: false,
      type: 'boolean',
    },
    minLines: {
      default: 0,
      type: 'integer',
    },
    publicOnly: {
      oneOf: [
        {
          default: false,
          type: 'boolean',
        },
        {
          additionalProperties: false,
          default: {},
          properties: {
            ancestorsOnly: {
              type: 'boolean',
            },
            cjs: {
              type: 'boolean',
            },
            esm: {
              type: 'boolean',
            },
            window: {
              type: 'boolean',
            },
          },
          type: 'object',
        },
      ],
    },
    require: {
      additionalProperties: false,
      default: {},
      properties: {
        ArrowFunctionExpression: {
          default: false,
          type: 'boolean',
        },
        ClassDeclaration: {
          default: false,
          type: 'boolean',
        },
        ClassExpression: {
          default: false,
          type: 'boolean',
        },
        FunctionDeclaration: {
          default: true,
          type: 'boolean',
        },
        FunctionExpression: {
          default: false,
          type: 'boolean',
        },
        MethodDefinition: {
          default: false,
          type: 'boolean',
        },
      },
      type: 'object',
    },
  },
  type: 'object',
};

const getOption = (context, baseObject, option, key) => {
  if (!_.has(context, `options[0][${option}][${key}]`)) {
    return baseObject.properties[key].default;
  }

  return context.options[0][option][key];
};

const getOptions = (context) => {
  const {
    publicOnly,
    contexts = [],
    exemptEmptyConstructors = true,
    exemptEmptyFunctions = false,
    enableFixer = true,
    minLines = 0,
  } = context.options[0] || {};

  return {
    contexts,
    enableFixer,
    exemptEmptyConstructors,
    exemptEmptyFunctions,
    minLines,
    publicOnly: ((baseObj) => {
      if (!publicOnly) {
        return false;
      }

      const properties = {};
      Object.keys(baseObj.properties).forEach((prop) => {
        const opt = getOption(context, baseObj, 'publicOnly', prop);
        properties[prop] = opt;
      });

      return properties;
    })(OPTIONS_SCHEMA.properties.publicOnly.oneOf[1]),
    require: ((baseObj) => {
      const properties = {};
      Object.keys(baseObj.properties).forEach((prop) => {
        const opt = getOption(context, baseObj, 'require', prop);
        properties[prop] = opt;
      });

      return properties;
    })(OPTIONS_SCHEMA.properties.require),
  };
};

/**
 * Given a list of comment nodes, return a map with numeric keys (source code line numbers) and comment token values.
 *
 * @param {Array} comments An array of comment nodes.
 * @returns {Map.<string,Node>} A map with numeric keys (source code line numbers) and comment token values.
 */
const getCommentLineNumbers = (comments) => {
  const map = new Map();

  comments.forEach((comment) => {
    for (let line = comment.loc.start.line; line <= comment.loc.end.line; line++) {
      map.set(line, comment);
    }
  });

  return map;
};

/**
 * Tells if a comment encompasses the entire line.
 *
 * @param {string} line The source line with a trailing comment
 * @param {number} lineNumber The one-indexed line number this is on
 * @param {ASTNode} comment The comment to remove
 * @returns {boolean} If the comment covers the entire line
 */
const isFullLineComment = (line, lineNumber, comment) => {
  const start = comment.loc.start;
  const end = comment.loc.end;
  const isFirstTokenOnLine = start.line === lineNumber && !line.slice(0, start.column).trim();
  const isLastTokenOnLine = end.line === lineNumber && !line.slice(end.column).trim();

  return comment &&
      (start.line < lineNumber || isFirstTokenOnLine) &&
      (end.line > lineNumber || isLastTokenOnLine);
};

/**
 * Identifies is a node is a FunctionExpression which is part of an IIFE
 *
 * @param {ASTNode} node Node to test
 * @returns {boolean} True if it's an IIFE
 */
const isIIFE = (node) => {
  return (
    (
      node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression'
    ) &&
    node.parent &&
    node.parent.type === 'CallExpression' &&
    node.parent.callee === node
  );
};

/**
 * Identifies is a node is a FunctionExpression which is embedded within a MethodDefinition or Property
 *
 * @param {ASTNode} node Node to test
 * @returns {boolean} True if it's a FunctionExpression embedded within a MethodDefinition or Property
 */
const isEmbedded = (node) => {
  if (!node.parent) {
    return false;
  }
  if (node !== node.parent.value) {
    return false;
  }
  if (node.parent.type === 'MethodDefinition') {
    return true;
  }
  if (node.parent.type === 'Property') {
    return node.parent.method === true || node.parent.kind === 'get' || node.parent.kind === 'set';
  }

  return false;
};

const getLinesCountInFunction = (funcNode, lines, commentLineNumbers, {
  skipComments = true,
  skipBlankLines = true,
} = {}) => {
  const node = isEmbedded(funcNode) ? funcNode.parent : funcNode;

  if (isIIFE(node)) {
    return null;
  }

  let lineCount = 0;

  for (let linePos = node.loc.start.line - 1; linePos < node.loc.end.line; ++linePos) {
    const line = lines[linePos];

    if (skipComments && commentLineNumbers.has(linePos + 1) && isFullLineComment(line, linePos + 1, commentLineNumbers.get(linePos + 1))) {
      continue;
    }
    if (skipBlankLines && line.match(/^\s*$/u)) {
      continue;
    }

    lineCount++;
  }

  return lineCount;
};

export default {
  create (context) {
    const sourceCode = context.getSourceCode();
    const settings = getSettings(context);
    if (!settings) {
      return {};
    }

    const {
      require: requireOption,
      contexts,
      publicOnly, exemptEmptyFunctions, exemptEmptyConstructors, enableFixer,
      minLines,
    } = getOptions(context);

    const checkJsDoc = (node, isFunctionContext) => {
      const jsDocNode = getJSDocComment(sourceCode, node, settings);

      if (jsDocNode) {
        return;
      }

      // For those who have options configured against ANY constructors (or setters or getters) being reported
      if (jsdocUtils.exemptSpeciaMethods(
        {tags: []}, node, context, [OPTIONS_SCHEMA],
      )) {
        return;
      }

      if (
        // Avoid reporting param-less, return-less functions (when `exemptEmptyFunctions` option is set)
        exemptEmptyFunctions && isFunctionContext ||

        // Avoid reporting  param-less, return-less constructor methods  (when `exemptEmptyConstructors` option is set)
        exemptEmptyConstructors && jsdocUtils.isConstructor(node)
      ) {
        const functionParameterNames = jsdocUtils.getFunctionParameterNames(node);
        if (!functionParameterNames.length && !jsdocUtils.hasReturnValue(node, context)) {
          return;
        }
      }

      if (minLines > 0) {
        const commentLineNumbers = getCommentLineNumbers(sourceCode.getAllComments());

        if (getLinesCountInFunction(node, sourceCode.lines, commentLineNumbers) <= minLines) {
          return;
        }
      }

      const fix = (fixer) => {
        // Default to one line break if the `minLines`/`maxLines` settings allow
        const lines = settings.minLines === 0 && settings.maxLines >= 1 ? 1 : settings.minLines;
        let baseNode = getReducedASTNode(node, sourceCode);

        let decorator;
        do {
          const tokenBefore = sourceCode.getTokenBefore(baseNode, {includeComments: true});
          decorator = getDecorator(tokenBefore, sourceCode);
          if (decorator) {
            baseNode = decorator;
          }
        } while (decorator);

        const indent = jsdocUtils.getIndent({
          text: sourceCode.getText(
            baseNode,
            baseNode.loc.start.column,
          ),
        });
        const {inlineCommentBlock} = contexts.find(({context: ctxt}) => {
          return ctxt === node.type;
        }) || {};
        const insertion = (inlineCommentBlock ?
          '/** ' :
          `/**\n${indent}*\n${indent}`) +
            `*/${'\n'.repeat(lines)}${indent.slice(0, -1)}`;

        return fixer.insertTextBefore(baseNode, insertion);
      };

      const report = () => {
        const loc = {
          end: node.loc.start + 1,
          start: node.loc.start,
        };
        context.report({
          fix: enableFixer ? fix : null,
          loc,
          messageId: 'missingJsDoc',
          node,
        });
      };

      if (publicOnly) {
        const opt = {
          ancestorsOnly: Boolean(publicOnly?.ancestorsOnly ?? false),
          esm: Boolean(publicOnly?.esm ?? true),
          initModuleExports: Boolean(publicOnly?.cjs ?? true),
          initWindow: Boolean(publicOnly?.window ?? false),
        };
        const exported = exportParser.isUncommentedExport(node, sourceCode, opt, settings);

        if (exported) {
          report();
        }
      } else {
        report();
      }
    };

    const hasOption = (prop) => {
      return requireOption[prop] || contexts.some((ctxt) => {
        return typeof ctxt === 'object' ? ctxt.context === prop : ctxt === prop;
      });
    };

    return {
      ...jsdocUtils.getContextObject(jsdocUtils.enforcedContexts(context, []), checkJsDoc),
      ArrowFunctionExpression (node) {
        if (!hasOption('ArrowFunctionExpression')) {
          return;
        }

        if (
          ['VariableDeclarator', 'AssignmentExpression', 'ExportDefaultDeclaration'].includes(node.parent.type) ||
          ['Property', 'ObjectProperty', 'ClassProperty'].includes(node.parent.type) && node === node.parent.value
        ) {
          checkJsDoc(node, true);
        }
      },

      ClassDeclaration (node) {
        if (!hasOption('ClassDeclaration')) {
          return;
        }

        checkJsDoc(node);
      },

      ClassExpression (node) {
        if (!hasOption('ClassExpression')) {
          return;
        }

        checkJsDoc(node);
      },

      FunctionDeclaration (node) {
        if (!hasOption('FunctionDeclaration')) {
          return;
        }

        checkJsDoc(node, true);
      },

      FunctionExpression (node) {
        if (hasOption('MethodDefinition') && node.parent.type === 'MethodDefinition') {
          checkJsDoc(node, true);

          return;
        }

        if (!hasOption('FunctionExpression')) {
          return;
        }

        if (
          ['VariableDeclarator', 'AssignmentExpression', 'ExportDefaultDeclaration'].includes(node.parent.type) ||
          ['Property', 'ObjectProperty', 'ClassProperty'].includes(node.parent.type) && node === node.parent.value
        ) {
          checkJsDoc(node, true);
        }
      },
    };
  },
  meta: {
    docs: {
      category: 'Stylistic Issues',
      description: 'Require JSDoc comments',
      recommended: 'true',
      url: 'https://github.com/gajus/eslint-plugin-jsdoc#eslint-plugin-jsdoc-rules-require-jsdoc',
    },

    fixable: 'code',

    messages: {
      missingJsDoc: 'Missing JSDoc comment.',
    },

    schema: [
      OPTIONS_SCHEMA,
    ],

    type: 'suggestion',
  },
};
