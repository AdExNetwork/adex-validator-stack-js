/* eslint-disable no-undef */
db.channels.createIndex({ validators: 1 })
db.eventAggregates.createIndex({ channelId: 1 })
db.eventAggregates.createIndex({ channelId: 1, created: 1 })
db.validatorMessages.createIndex({ channelId: 1 })
db.validatorMessages.createIndex({ 'msg.type': 1, 'msg.stateRoot': 1 })
db.validatorMessages.createIndex({ channnelId: 1, type: 1, 'msg.type': 1, _id: -1 })
