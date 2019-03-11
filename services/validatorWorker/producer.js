const assert = require('assert')
const BN = require('bn.js')
const db = require('../../db')
const cfg = require('../../cfg')
const { getBalancesAfterFeesTree } = require('./lib')

function tick(channel, force) {
	const eventAggrCol = db.getMongo().collection('eventAggregates')
	const stateTreeCol = db.getMongo().collection('channelStateTrees')

	return stateTreeCol
		.findOne({ _id: channel.id })
		.then(function(stateTree) {
			return stateTree || { balances: {}, lastEvAggr: new Date(0) }
		})
		.then(function(stateTree) {
			// Process eventAggregates, from old to new, newer than the lastEvAggr time
			return eventAggrCol
				.find({
					channelId: channel.id,
					created: { $gt: stateTree.lastEvAggr }
				})
				.sort({ created: 1 })
				.limit(cfg.PRODUCER_MAX_AGGR_PER_TICK)
				.toArray()
				.then(function(aggrs) {
					logMerge(channel, aggrs)

					const shouldUpdate = force || aggrs.length
					if (!shouldUpdate) {
						return { channel }
					}

					// balances should be addition of eventPayouts
					//

					const { balances, balancesAfterFees, newStateTree } = mergeAggrs(
						stateTree,
						aggrs,
						// @TODO obtain channel payment info
						{ ...channel, amount: new BN(1), depositAmount: new BN(channel.depositAmount) }
					)

					return stateTreeCol
						.updateOne({ _id: channel.id }, { $set: newStateTree }, { upsert: true })
						.then(function() {
							return { channel, balances, balancesAfterFees, newStateTree }
						})
				})
		})
}

// Pure, should not mutate inputs
// @TODO isolate those pure functions into a separate file
function mergeAggrs(stateTree, aggrs, paymentInfo) {
	const newStateTree = {
		balances: {},
		balancesAfterFees: {},
		lastEvAggr: stateTree.lastEvAggr
	}

	// Build an intermediary balances representation
	const balances = {}
	Object.keys(stateTree.balances).forEach(function(acc) {
		balances[acc] = new BN(stateTree.balances[acc], 10)
		assert.ok(!balances[acc].isNeg(), 'balance should not be negative')
	})

	// Merge in all the aggrs
	aggrs.forEach(function(evAggr) {
		newStateTree.lastEvAggr = new Date(Math.max(
			newStateTree.lastEvAggr.getTime(),
			evAggr.created.getTime()
		))
		// @TODO do something about this hardcoded event type assumption
		mergePayoutsIntoBalances(balances, evAggr.events.IMPRESSION, paymentInfo)
	})

	// Rewrite into the newStateTree
	Object.keys(balances).forEach(function(acc) {
		newStateTree.balances[acc] = balances[acc].toString(10)
	})

	const balancesAfterFees = getBalancesAfterFeesTree(balances, paymentInfo)
	// Rewrite into the newStateTree
	Object.keys(balancesAfterFees).forEach(function(acc) {
		newStateTree.balancesAfterFees[acc] = balancesAfterFees[acc].toString(10)
	})

	return { balances, balancesAfterFees, newStateTree }
}

// Mutates the balances input
// For now, this just disregards anything that goes over the depositAmount
function mergePayoutsIntoBalances(balances, events, paymentInfo) {
	if (!events) return

	// total of state tree balance
	const total = Object.values(balances).reduce((a, b) => a.add(b), new BN(0))
	// remaining of depositAmount
	let remaining = paymentInfo.depositAmount.sub(total)

	assert.ok(!remaining.isNeg(), 'remaining starts negative: total>depositAmount')

	const { eventPayouts } = events
	// take the eventPayouts key
	Object.keys(eventPayouts).forEach(function(acc) {
		if (!balances[acc]) balances[acc] = new BN(0, 10)
		
		const eventPayout = new BN(eventPayouts[acc])
		const toAdd = BN.min(remaining, eventPayout)	
		assert.ok(!toAdd.isNeg(), 'toAdd must never be negative')

		balances[acc] = balances[acc].add(toAdd)
		remaining = remaining.sub(toAdd)
		assert.ok(!remaining.isNeg(), 'remaining must never be negative')
	})
}

function logMerge(channel, eventAggrs) {
	if (eventAggrs.length === 0) return
	console.log(
		`validatorWorker: channel ${channel.id}: processing ${eventAggrs.length} event aggregates`
	)
}

module.exports = { tick }
