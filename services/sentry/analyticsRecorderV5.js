const db = require('../../db')
const toBalancesKey = require('./toBalancesKey')
const logger = require('../logger')('sentry')

function getHourEpoch() {
	return Math.floor(Date.now() / 3600000)
}

const linuxDistros = [
	'Arch',
	'CentOS',
	'Slackware',
	'Fedora',
	'Debian',
	'Deepin',
	'elementary OS',
	'Gentoo',
	'Mandriva',
	'Manjaro',
	'Mint',
	'PCLinuxOS',
	'Raspbian',
	'Sabayon',
	'SUSE',
	'Ubuntu',
	'RedHat'
]
const whitelisted = [
	'Android',
	'Android-x86',
	'iOS',
	'BlackBerry',
	'Chromium OS',
	'Fuchsia',
	'Mac OS',
	'Windows',
	'Windows Phone',
	'Windows Mobile',
	'Linux',
	'NetBSD',
	'Nintendo',
	'OpenBSD',
	'PlayStation',
	'Tizen',
	'Symbian',
	'KAIOS'
]
// eslint-disable-next-line no-unused-vars
function mapOS(osName) {
	if (linuxDistros.includes(osName)) return 'Linux'
	if (whitelisted.includes(osName)) return osName
	return 'Other'
}

function record(channel, session, events, payouts) {
	const analyticsCol = db.getMongo().collection('analytics')

	const osName = mapOS(session.ua.os.name)
	const time = new Date(getHourEpoch() * 3600000)

	const batch = events
		.filter(ev => (ev.type === 'IMPRESSION' || ev.type === 'CLICK') && ev.publisher)
		.map((ev, i) => {
			const payout = payouts[i]
			const publisher = toBalancesKey(ev.publisher)
			// This should never happen, as the conditions we are checking for in the .filter are the same as getPayout's
			if (!payout) return Promise.resolve()
			// @TODO is there a way to get rid of this ugly hardcode (10**18)?
			const MUL = 10 ** 18
			const payAmount = parseInt(payout[1].toString(), 10) / MUL
			// NOTE: copied from getPayout
			const adUnit =
				Array.isArray(channel.spec.adUnits) && channel.spec.adUnits.find(u => u.ipfs === ev.adUnit)
			const ref = ev.ref || session.referrerHeader
			const hostname = ref ? ref.split('/')[2] : null
			return analyticsCol.updateOne(
				{
					keys: {
						time,
						campaignId: channel.id,
						adUnit: ev.adUnit,
						adSlot: ev.adSlot,
						adSlotType: adUnit ? adUnit.type : '',
						advertiser: channel.creator,
						publisher,
						hostname,
						country: session.country,
						osName
					}
				},
				{ $inc: { [`${ev.type}.paid`]: payAmount, [`${ev.type}.count`]: 1 } },
				{ upsert: true }
			)
		})
	return Promise.all(batch).catch(e => logger.error(e))
}

module.exports = { record }
