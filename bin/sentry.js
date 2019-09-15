#!/usr/bin/env node
const express = require('express')
const bodyParser = require('body-parser')
const cors = require('cors')
const { errors } = require('celebrate')
const yargs = require('yargs')
const db = require('../db')
const cfg = require('../cfg')
const adapters = require('../adapters')
const authMiddleware = require('../middlewares/auth')
const channelRoutes = require('../routes/channel')
const channelCreate = require('../routes/channelCreate')
const logger = require('../services/logger')('sentry')
const createCluster = require('../services/cluster')
const analyticsRoutes = require('../routes/analytics')

const { argv } = yargs
	.usage('Usage $0 [options]')
	.describe('adapter', 'the adapter for authentication and signing')
	.choices('adapter', Object.keys(adapters))
	.default('adapter', 'ethereum')
	.describe('keystoreFile', 'path to JSON Ethereum keystore file')
	.describe('dummyIdentity', 'the identity to use with the dummy adapter')
	.boolean('clustered')
	.describe('clustered', 'run app in cluster mode with multiple workers')
	.demandOption(['adapter'])

const adapter = new adapters[argv.adapter].Adapter(argv, cfg)
const app = express()
const port = process.env.PORT || 8005

app.use(cors())
app.use(bodyParser.json())
app.use(authMiddleware.forAdapter(adapter))
app.use('/channel', channelRoutes)
app.use('/channel', channelCreate.forAdapter(adapter))
app.use('/analytics', analyticsRoutes)
app.use('/cfg', (_, res) => res.send(cfg))
app.use(errors())

if (argv.clustered) {
	createCluster(run)
} else {
	// dont run in cluster mode
	run()
}

function run() {
	db.connect()
		.then(function() {
			return adapter.init()
		})
		.then(function() {
			app.listen(port, () => logger.info(`Sentry listening on port ${port}!`))
		})
		.catch(function(err) {
			logger.error(err)
			process.exit(1)
		})
}
