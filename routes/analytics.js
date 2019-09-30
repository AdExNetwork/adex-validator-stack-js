const express = require('express')
const { celebrate } = require('celebrate')
const { promisify } = require('util')
const schema = require('./schemas')
const toBalancesKey = require('../services/sentry/lib/toBalancesKey')
const { channelIfExists } = require('../middlewares/channel')
const { authRequired } = require('../middlewares/auth')
const db = require('../db')

const router = express.Router()
const redisCli = db.getRedis()
const redisGet = promisify(redisCli.get).bind(redisCli)
const validate = celebrate({ query: schema.eventTimeAggr })
const analyticsNotCached = (req, res) => analytics(req).then(res.json.bind(res))

// Global statistics
router.get('/', validate, redisCached(300, analytics))
router.get('/for-user', validate, authRequired, analyticsNotCached)

// :id is channelId: needs to be named that way cause of channelIfExists
router.get('/:id', validate, channelIfExists, redisCached(600, analytics))
router.get('/for-user/:id', validate, authRequired, channelIfExists, analyticsNotCached)

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
function getTimeframe(timeframe) {
	// every month in one year
	if (timeframe === 'year') return { period: 365 * DAY, interval: 30 * DAY }
	// every day in one month
	if (timeframe === 'month') return { period: 30 * DAY, interval: DAY }
	// every 6 hours in a week
	if (timeframe === 'week') return { period: 7 * DAY, interval: 6 * HOUR }
	// every hour in one day
	if (timeframe === 'day') return { period: DAY, interval: HOUR }
	// every minute in an hour
	if (timeframe === 'hour') return { period: HOUR, interval: MINUTE }

	// default is day
	return { period: DAY, interval: HOUR }
}

function getProjAndMatch(session, channelId, period, eventType, metric) {
	const timeMatch = { created: { $gt: new Date(Date.now() - period) } }
	const uid = session ? toBalancesKey(session.uid) : null
	const filteredMatch = uid
		? {
				...timeMatch,
				[`events.${eventType}.${metric}.${uid}`]: { $exists: true }
		  }
		: timeMatch
	const match = channelId ? { ...filteredMatch, channelId } : filteredMatch
	const projectValue = uid
		? { $toLong: `$events.${eventType}.${metric}.${uid}` }
		: {
				$sum: {
					$map: {
						input: { $objectToArray: `$events.${eventType}.${metric}` },
						as: 'item',
						in: { $toLong: '$$item.v' }
					}
				}
		  }
	const project = {
		created: 1,
		value: projectValue
	}
	return { match, project }
}

function analytics(req) {
	const eventsCol = db.getMongo().collection('eventAggregates')
	const { limit, timeframe, eventType, metric } = req.query
	const { period, interval } = getTimeframe(timeframe)
	const { project, match } = getProjAndMatch(req.session, req.params.id, period, eventType, metric)
	const appliedLimit = Math.min(200, limit)
	const pipeline = [
		{ $match: match },
		{ $project: project },
		{
			$group: {
				_id: {
					$subtract: [{ $toLong: '$created' }, { $mod: [{ $toLong: '$created' }, interval] }]
				},
				value: { $sum: '$value' }
			}
		},
		{ $sort: { _id: 1, channelId: 1, created: 1 } },
		{ $limit: appliedLimit },
		{ $project: { value: '$value', time: '$_id', _id: 0 } }
	]

	return eventsCol
		.aggregate(pipeline)
		.toArray()
		.then(aggr => ({
			limit: appliedLimit,
			aggr: aggr.map(x => ({
				...x,
				value: x.value.toLocaleString('fullwide', { useGrouping: false })
			}))
		}))
}

function redisCached(seconds, fn) {
	return function(req, res, next) {
		const key = `CACHE:${req.originalUrl}`

		redisGet(key)
			.then(cached => {
				if (cached) {
					res.setHeader('Content-Type', 'application/json')
					res.send(cached)
					return Promise.resolve()
				}
				return fn(req).then(resp => {
					// no need to wait for that
					redisCli.setex(key, seconds, JSON.stringify(resp))
					res.send(resp)
				})
			})
			.catch(next)
	}
}

module.exports = router