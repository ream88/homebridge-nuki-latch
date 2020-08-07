const packageJson = require('../package.json')
const http = require('http')

let Service, Characteristic

const DOOR_STATE_DOOR_CLOSED = 2
const DOOR_STATE_DOOR_OPENED = 3
const LOCK_STATE_LOCKED = 1
const LOCK_STATE_UNLOCKED = 3
const LOCK_STATE_UNLATCHED = 5
const LOCK_ACTION_UNLOCK = 1
const LOCK_ACTION_LOCK = 2
const LOCK_ACTION_UNLATCH = 3

module.exports = (homebridge) => {
  Service = homebridge.hap.Service
  Characteristic = homebridge.hap.Characteristic

  homebridge.registerAccessory('NukiLatch', NukiLatch)
}

function parseJSON (data) {
  return new Promise((resolve, reject) => {
    try {
      resolve(JSON.parse(data))
    } catch (error) {
      reject(error)
    }
  })
}

class NukiBridge {
  constructor (log, hostname, port, token) {
    this.log = log

    this.host = `${hostname}:${port}`
    this.token = token
  }

  fetch (path, params = {}) {
    const url = new URL(path, `http://${this.host}`)
    url.searchParams.append('token', this.token)

    for (const [name, value] of Object.entries(params)) {
      url.searchParams.append(name, value)
    }

    return new Promise((resolve) => {
      http.get(url.toString(), (response) => {
        let data = ''

        response.on('data', (chunk) => {
          data += chunk
        })

        response.on('end', () => {
          resolve(data)
        })
      })
    })
  }

  loadDevices () {
    return new Promise((resolve) => {
      this.log.debug('Loading devices…')

      this.fetch('/list').then(parseJSON).then((devices) => {
        this.log.debug('Devices loaded:', JSON.stringify(devices))

        resolve(devices)
      })
    })
  }

  installCallback (url) {
    this.log.debug('Loading callbacks…')

    this.fetch('/callback/list').then(parseJSON).then((response) => {
      this.log.debug('Callbacks loaded:', response)

      const callback = response.callbacks.find((callback) => {
        return callback.url === url
      })

      if (callback) {
        this.log.debug(`Callback ${url} already registered`)
      } else {
        this.fetch('/callback/add', { url: url }).then(parseJSON).then(response => {
          if (response.success) {
            this.log.debug(`Callback ${url} successfully registered`)
          } else {
            this.log.error(`Callback ${url} register failed: ${response.message}`)
          }
        })
      }
    })
  }

  lock (id) {
    this.log.debug('Locking door with ID:', id)
    return this.fetch('/lockAction', { nukiId: id, action: LOCK_ACTION_LOCK })
  }

  unlock (id) {
    this.log.debug('Unlocking door with ID:', id)
    return this.fetch('/lockAction', { nukiId: id, action: LOCK_ACTION_UNLOCK })
  }

  unlatch (id) {
    this.log.debug('Unlocking and unlatching door with ID:', id)
    return this.fetch('/lockAction', { nukiId: id, action: LOCK_ACTION_UNLATCH })
  }
}

class NukiLatch {
  constructor (log, config) {
    this.log = log
    this.config = config

    this.informationService = new Service.AccessoryInformation()
    this.informationService
      .setCharacteristic(Characteristic.Manufacturer, packageJson.author.name)
      .setCharacteristic(Characteristic.Model, packageJson.name)
      .setCharacteristic(Characteristic.FirmwareRevision, packageJson.version)

    this.lockService = new Service.LockMechanism(config.name)
    this.lockService
      .getCharacteristic(Characteristic.LockTargetState)
      .on('set', (state, callback) => this.setLockTargetState(state, callback))
      .updateValue(Characteristic.LockTargetState.UNKNOWN)
    this.lockService
      .getCharacteristic(Characteristic.LockCurrentState)
      .updateValue(Characteristic.LockCurrentState.UNKNOWN)

    this.latchService = new Service.LockMechanism(this.config.name, 'latch')
    this.latchService
      .getCharacteristic(Characteristic.LockTargetState)
      .on('set', (state, callback) => this.setLatchTargetState(state, callback))
      .updateValue(Characteristic.LockTargetState.UNKNOWN)
    this.latchService
      .getCharacteristic(Characteristic.LockCurrentState)
      .updateValue(Characteristic.LockCurrentState.UNKNOWN)

    this.contactSensorService = new Service.ContactSensor()
    this.batteryService = new Service.BatteryService()

    this.httpServer = http.createServer((request, response) => {
      let data = ''

      request.on('data', (chunk) => {
        data += chunk
      })

      request.on('end', () => {
        this.log.debug('Incoming callback:', data)
        this.updateDoorState(JSON.parse(data))
      })

      response.end()
    })

    const httpServerPort = 8000

    this.httpServer.listen(httpServerPort)

    const nukiBridgeIp = ''
    const nukiBridgePort = ''
    const nukiBridgeToken = ''
    const nukiId = 0

    const callbackURL = `http://127.0.0.1:${httpServerPort}`

    this.bridge = new NukiBridge(this.log, nukiBridgeIp, nukiBridgePort, nukiBridgeToken)
    this.bridge.installCallback(callbackURL)
    this.bridge.loadDevices().then((devices) => {
      this.door = devices.find((device) => {
        return device.nukiId === nukiId
      })

      this.updateDoorState(this.door)
    })
  }

  getServices () {
    return [
      this.informationService,
      this.lockService,
      this.latchService,
      this.contactSensorService,
      this.batteryService
    ]
  }

  setLockTargetState (state, callback) {
    this.lockService.getCharacteristic(Characteristic.LockTargetState).updateValue(state)

    switch (state) {
      case Characteristic.LockCurrentState.SECURED:
        this.bridge.lock(this.door.nukiId).then(parseJSON).then((response) => {
          if (response.success) {
            this.lockService.getCharacteristic(Characteristic.LockTargetState).updateValue(Characteristic.LockTargetState.SECURED)
            this.lockService.getCharacteristic(Characteristic.LockCurrentState).updateValue(Characteristic.LockCurrentState.SECURED)
            this.latchService.getCharacteristic(Characteristic.LockTargetState).updateValue(Characteristic.LockTargetState.SECURED)
            this.latchService.getCharacteristic(Characteristic.LockCurrentState).updateValue(Characteristic.LockCurrentState.SECURED)
          }

          callback(null)
        })
        break

      case Characteristic.LockCurrentState.UNSECURED:
        this.bridge.unlock(this.door.nukiId).then(parseJSON).then((response) => {
          if (response.success) {
            this.lockService.getCharacteristic(Characteristic.LockTargetState).updateValue(Characteristic.LockTargetState.UNSECURED)
            this.lockService.getCharacteristic(Characteristic.LockCurrentState).updateValue(Characteristic.LockCurrentState.UNSECURED)
            this.latchService.getCharacteristic(Characteristic.LockTargetState).updateValue(Characteristic.LockTargetState.SECURED)
            this.latchService.getCharacteristic(Characteristic.LockCurrentState).updateValue(Characteristic.LockCurrentState.SECURED)
          }

          callback(null)
        })
        break
    }
  }

  setLatchTargetState (state, callback) {
    this.latchService.getCharacteristic(Characteristic.LockTargetState).updateValue(state)

    switch (state) {
      case Characteristic.LockCurrentState.UNSECURED:
        this.bridge.unlatch(this.door.nukiId).then(parseJSON).then((response) => {
          if (response.success) {
            this.lockService.getCharacteristic(Characteristic.LockTargetState).updateValue(Characteristic.LockTargetState.UNSECURED)
            this.lockService.getCharacteristic(Characteristic.LockCurrentState).updateValue(Characteristic.LockCurrentState.UNSECURED)
            this.latchService.getCharacteristic(Characteristic.LockTargetState).updateValue(Characteristic.LockTargetState.UNSECURED)
            this.latchService.getCharacteristic(Characteristic.LockCurrentState).updateValue(Characteristic.LockCurrentState.UNSECURED)
          }

          setTimeout(() => {
            this.latchService.setCharacteristic(Characteristic.LockTargetState, Characteristic.LockTargetState.SECURED)
          }, 3000)

          callback(null)
        })
        break
    }
  }

  updateDoorState (data) {
    const state = data.lastKnownState ? data.lastKnownState : data
    this.log.debug('Updating state:', data)

    switch (state.state) {
      case LOCK_STATE_LOCKED:
        this.lockService.getCharacteristic(Characteristic.LockTargetState).updateValue(Characteristic.LockTargetState.SECURED)
        this.lockService.getCharacteristic(Characteristic.LockCurrentState).updateValue(Characteristic.LockCurrentState.SECURED)
        this.latchService.getCharacteristic(Characteristic.LockTargetState).updateValue(Characteristic.LockTargetState.SECURED)
        this.latchService.getCharacteristic(Characteristic.LockCurrentState).updateValue(Characteristic.LockCurrentState.SECURED)
        break

      case LOCK_STATE_UNLOCKED:
        this.lockService.getCharacteristic(Characteristic.LockTargetState).updateValue(Characteristic.LockTargetState.UNSECURED)
        this.lockService.getCharacteristic(Characteristic.LockCurrentState).updateValue(Characteristic.LockCurrentState.UNSECURED)
        this.latchService.getCharacteristic(Characteristic.LockTargetState).updateValue(Characteristic.LockTargetState.SECURED)
        this.latchService.getCharacteristic(Characteristic.LockCurrentState).updateValue(Characteristic.LockCurrentState.SECURED)
        break

      case LOCK_STATE_UNLATCHED:
        this.lockService.getCharacteristic(Characteristic.LockTargetState).updateValue(Characteristic.LockTargetState.UNSECURED)
        this.lockService.getCharacteristic(Characteristic.LockCurrentState).updateValue(Characteristic.LockCurrentState.UNSECURED)
        this.latchService.getCharacteristic(Characteristic.LockTargetState).updateValue(Characteristic.LockTargetState.UNSECURED)
        this.latchService.getCharacteristic(Characteristic.LockCurrentState).updateValue(Characteristic.LockCurrentState.UNSECURED)
        break

      default:
        this.log.warn('Unhandled door state:', state)
        this.currentState = Characteristic.LockCurrentState.UNKNOWN
    }

    if (state.doorsensorState === DOOR_STATE_DOOR_CLOSED) {
      this.contactSensorService.getCharacteristic(Characteristic.ContactSensorState).updateValue(Characteristic.ContactSensorState.CONTACT_DETECTED)
    } else if (state.doorsensorState === DOOR_STATE_DOOR_OPENED) {
      this.contactSensorService.getCharacteristic(Characteristic.ContactSensorState).updateValue(Characteristic.ContactSensorState.CONTACT_NOT_DETECTED)
    }
  }
}
