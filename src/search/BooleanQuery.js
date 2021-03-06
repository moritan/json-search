/**
 * @constructor
 * @implements {Query}
 * @param {Array.<BooleanClause>} [clauses]
 * @param {number} [minimumOptionalMatches]
 * @param {number} [boost]
 */

function BooleanQuery(clauses, minimumOptionalMatches, boost) {
	this.clauses = clauses || [];
	this.minimumOptionalMatches = minimumOptionalMatches || 0;
	this.boost = boost || 1.0;
};

/**
 * @type {Array.<BooleanClause>}
 */

BooleanQuery.prototype.clauses;

/**
 * @type {number}
 */

BooleanQuery.prototype.minimumOptionalMatches = 0;

/**
 * @type {number}
 */

BooleanQuery.prototype.boost = 1.0;

/**
 * @param {Similarity} similarity
 * @param {Index} index
 * @return {Stream}
 */

BooleanQuery.prototype.score = function (similarity, index) {
	return new BooleanScorer(this, similarity, index);
};

/**
 * @return {Array.<TermVector>}
 */

BooleanQuery.prototype.extractTerms = function () {
	var x, xl, result = [];
	for (x = 0, xl = this.clauses.length; x < xl; ++x) {
		result = result.concat(this.clauses[x].query.extractTerms());
	}
	return result;
};

/**
 * @return {Query}
 */

BooleanQuery.prototype.rewrite = function () {
	var result, x, xl, rewrote = false;
	
	if (this.minimumOptionalMatches === 0 && this.clauses.length === 1 && this.clauses[0].occur !== Occur.MUST_NOT) {
		result = this.clauses[0].query;
		result = result.rewrite();
		result.boost *= this.boost;
	} else {
		result = new BooleanQuery();
		result.boost = this.boost;
		for (x = 0, xl = this.clauses.length; x < xl; ++x) {
			result.clauses[x] = new BooleanClause(this.clauses[x].query.rewrite(), this.clauses[x].occur);
			if (result.clauses[x].query !== this.clauses[x].query) {
				rewrote = true;
			}
		}
		
		if (!rewrote) {
			result = this;
		}
	}
	
	return /** @type {Query} */ (result);
};


/**
 * @protected
 * @constructor
 * @extends {Stream}
 * @param {BooleanQuery} query
 * @param {Similarity} similarity
 * @param {Index} index
 */

function BooleanScorer(query, similarity, index) {
	Stream.call(this);
	this._query = query;
	this._similarity = similarity;
	this._index = index;
	this._inputs = [];
	
	this.addInputs(query.clauses);
};

BooleanScorer.prototype = Object.create(Stream.prototype);

/**
 * @protected
 * @type {BooleanQuery} 
 */

BooleanScorer.prototype._query;

/**
 * @protected
 * @type {Similarity} 
 */

BooleanScorer.prototype._similarity;

/**
 * @protected
 * @type {Index} 
 */

BooleanScorer.prototype._index;

/**
 * @protected
 * @type {Array.<BooleanClauseStream>}
 */

BooleanScorer.prototype._inputs;

/**
 * @protected
 * @type {number}
 */

BooleanScorer.prototype._collectorCount = 0;

/**
 * @param {Array.<BooleanClause>} clauses
 */

BooleanScorer.prototype.addInputs = function (clauses) {
	var self = this;
	clauses.forEach(function (clause) {
		var collector = new SingleCollector(function onCollection(done, data) {
			if (!done) {
				return self.match();
			} else if (done === true) {
				bcs.collector = null;
				self._collectorCount--;
				
				if (self._collectorCount === 0 || bcs.occur === Occur.MUST) {
					self._collectorCount = 0;  //to pass sanity checks
					self.end();
				} else if (self._collectorCount > 0) {
					self.match();
				}
			} else {  //done instanceof Error
				self.error(done);
			}
		}), 
		bcs = new BooleanClauseStream(clause.query, clause.occur, collector);
		
		clause.query.score(self._similarity, self._index).pipe(collector);
		self._inputs.push(bcs);
		self._collectorCount++;
	});
};

/**
 */

BooleanScorer.prototype.match = function () {
	var x, xl, docs = [], lowestIndex = 0, lowestID, match = false, optionalMatches = 0, doc;
	
	if (this.isPaused()) {
		return;  //scorer is paused, proceed no further
	}
	
	//collect all documents, find lowest document ID
	for (x = 0, xl = this._inputs.length; x < xl; ++x) {
		if (this._inputs[x].collector) {
			docs[x] = this._inputs[x].collector.data;
			
			if (typeof docs[x] === "undefined") {
				return;  //not all collectors are full
			}
		} else {
			docs[x] = undefined;
		}
		
		if (x > 0 && (!docs[lowestIndex] || (docs[x] && docs[x].id < docs[lowestIndex].id))) {
			lowestIndex = x;
		}
	}
	
	lowestID = docs[lowestIndex].id;
	doc = new DocumentTerms(lowestID);
	
	//perform boolean logic
	for (x = 0, xl = this._inputs.length; x < xl; ++x) {
		if (docs[x] && docs[x].id === lowestID) {
			if (this._inputs[x].occur === Occur.MUST_NOT) {
				match = false;
				break;  //this document has a forbidden term
			} else {  //MUST or SHOULD
				if (this._inputs[x].occur === Occur.SHOULD) {
					optionalMatches++;
				}
				match = true;
				doc.terms = doc.terms.concat(docs[x].terms);
				doc.sumOfSquaredWeights += docs[x].sumOfSquaredWeights;
				doc.score += docs[x].score;
			}
		} else if (this._inputs[x].occur === Occur.MUST) {
			match = false;
			break;  //this document does not have a required term
		}
	}
	
	if (match && optionalMatches >= this._query.minimumOptionalMatches) {
		doc.score *= this._query.boost;
		doc.sumOfSquaredWeights *= this._query.boost * this._query.boost;
		this.emit(doc);
	}
	
	//remove documents with lowestID
	for (x = 0, xl = this._inputs.length; x < xl; ++x) {
		if (docs[x] && docs[x].id === lowestID) {
			this._inputs[x].collector.drain();
		}
	}
};

/**
 */

BooleanScorer.prototype.onResume = function () {
	var self = this;
	setTimeout(function () {
		if (self._collectorCount > 0) {
			self.match();
		}
	}, 0);
};

/**
 */

BooleanScorer.prototype.onEnd = function () {
	//sanity check
	if (this._collectorCount) {
		throw new Error("BooleanScorer#end called while there are still collectors attached!");
	}
	
	this.emitEnd();
	this._cleanup();
};

/**
 * @param {Error} err
 */

BooleanScorer.prototype.onError = function (err) {
	this.emitError(err);
	this._cleanup();
};

/**
 * @private
 */

BooleanScorer.prototype._cleanup = function () {
	var x, xl;
	for (x = 0, xl = this._inputs.length; x < xl; ++x) {
		if (this._inputs[x].collector) {
			this._inputs[x].collector.end();
		}
	}
	this._inputs = [];
};


/**
 * @protected
 * @constructor
 * @extends {BooleanClause}
 * @param {Query} query
 * @param {Occur} occur
 * @param {Stream} collector
 */

function BooleanClauseStream(query, occur, collector) {
	//BooleanClause.call(this, query, occur);
	this.query = query;
	this.occur = occur;
	this.collector = collector;
};

BooleanClauseStream.prototype = Object.create(BooleanClause.prototype);

/**
 * @type {Stream}
 */

BooleanClauseStream.prototype.collector;


exports.BooleanQuery = BooleanQuery;