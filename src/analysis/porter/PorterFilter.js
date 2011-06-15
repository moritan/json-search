/**
 * Transforms the token stream as per the Porter stemming algorithm.
 * 
 * Note: the input to the stemming filter must already be in lower case,
 * so you will need to use LowerCaseFilter farther down the Tokenizer 
 * chain in order for this to work properly!
 * 
 * @constructor
 * @implements {Analyzer}
 * @param {Analyzer} analyzer
 */

function PorterFilter(analyzer) {
	this.analyzer = analyzer;
};

/**
 * @type {Analyzer}
 */

PorterFilter.prototype.analyzer;

/**
 * @param {string} value
 * @param {FieldName} [field]
 * @return {Array.<Token>}
 */

PorterFilter.prototype.parse = function (value, field) {
	var x, xl, result = this.analyzer.parse(value, field);
	for (x = 0, xl = result.length; x < xl; ++x) {
		if (typeof result[x].value === "string") {
			result[x].value = porterStem(result[x].value);
		}
	}
	return result;
};


exports.PorterFilter = PorterFilter;