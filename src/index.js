const packageJson = require('../package.json')
const http = require('http')

let Service, Characteristic

const DOOR_STATE_DOOR_CLOSED = 2
const DOOR_STATE_DOOR_OPENED = 3

const LOCK_STATE_LOCKED = 1
const LOCK_STATE_JAMMED = 2
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

function readData (stream) {
  return new Promise((resolve) => {
    let data = ''

    stream.on('data', (chunk) => {
      data += chunk
    })

    stream.on('end', () => {
      resolve(data)
    })
  })
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
      http.get(url.toString(), resolve)
    })
  }

  loadDevices () {
    return new Promise((resolve) => {
      this.log.debug('Loading devices…')

      this.fetch('/list').then(readData).then(parseJSON).then((devices) => {
        this.log.debug('Devices loaded:', JSON.stringify(devices))

        resolve(devices)
      })
    })
  }

  installCallback (url) {
    this.log.debug('Loading callbacks…')

    this.fetch('/callback/list').then(readData).then(parseJSON).then((response) => {
      this.log.debug('Callbacks loaded:', response)

      const callback = response.callbacks.find((callback) => callback.url === url)

      if (callback) {
        this.log.debug(`Callback ${url} already registered`)
      } else {
        this.fetch('/callback/add', { url: url }).then(readData).then(parseJSON).then(response => {
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
    this.log.debug('Locking SmartLock with ID:', id)
    return this.fetch('/lockAction', { nukiId: id, action: LOCK_ACTION_LOCK })
  }

  unlock (id) {
    this.log.debug('Unlocking SmartLock with ID:', id)
    return this.fetch('/lockAction', { nukiId: id, action: LOCK_ACTION_UNLOCK })
  }

  unlatch (id) {
    this.log.debug('Unlocking and unlatching SmartLock with ID:', id)
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

    this.lockService.getCharacteristic(Characteristic.LockTargetState).updateValue(Characteristic.LockTargetState.SECURED)
    this.lockService.getCharacteristic(Characteristic.LockCurrentState).updateValue(Characteristic.LockCurrentState.SECURED)

    this.latchService = new Service.LockMechanism(this.config.name, 'latch')
    this.latchService
      .getCharacteristic(Characteristic.LockTargetState)
      .on('set', (state, callback) => this.setLatchTargetState(state, callback))

    this.latchService.getCharacteristic(Characteristic.LockTargetState).updateValue(Characteristic.LockTargetState.SECURED)
    this.latchService.getCharacteristic(Characteristic.LockCurrentState).updateValue(Characteristic.LockCurrentState.SECURED)

    this.contactSensorService = new Service.ContactSensor()
    this.batteryService = new Service.BatteryService()

    // HTTP Server for Nuki bridge callbacks
    http.createServer((request, response) => {
      readData(request).then(parseJSON).then((state) => this.updateSmartLockState(state))
      response.end()
    }).listen(this.config.homebridgePort)

    this.bridge = new NukiBridge(this.log, this.config.nukiBridgeIp, this.config.nukiBridgePort, this.config.nukiBridgeToken)
    this.bridge.installCallback(`${this.config.homebridgeIp}:${this.config.homebridgePort}`)
    this.bridge.loadDevices().then((devices) => {
      this.door = devices.find((device) => device.nukiId === this.config.nukiId)
      this.updateSmartLockState(this.door)
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
    this.log.debug('setLockTargetState to:', state)

    this.lockService.getCharacteristic(Characteristic.LockTargetState).updateValue(state)

    switch (state) {
      case Characteristic.LockCurrentState.SECURED:
        this.bridge.lock(this.door.nukiId).then(readData).then(parseJSON).then((response) => {
          if (response.success) {
            this.lockService.getCharacteristic(Characteristic.LockTargetState).updateValue(Characteristic.LockTargetState.SECURED)
            this.latchService.getCharacteristic(Characteristic.LockTargetState).updateValue(Characteristic.LockTargetState.SECURED)
          }
        })
        break

      case Characteristic.LockCurrentState.UNSECURED:
        this.bridge.unlock(this.door.nukiId).then(readData).then(parseJSON).then((response) => {
          if (response.success) {
            this.lockService.getCharacteristic(Characteristic.LockTargetState).updateValue(Characteristic.LockTargetState.UNSECURED)
            this.latchService.getCharacteristic(Characteristic.LockTargetState).updateValue(Characteristic.LockTargetState.SECURED)
          }
        })
        break
    }

    callback(null)
  }

  setLatchTargetState (state, callback) {
    this.log.debug('setLatchTargetState to:', state)

    switch (state) {
      case Characteristic.LockCurrentState.UNSECURED:
        this.bridge.unlatch(this.door.nukiId).then(readData).then(parseJSON).then((response) => {
          if (response.success) {
            this.lockService.getCharacteristic(Characteristic.LockTargetState).updateValue(Characteristic.LockTargetState.UNSECURED)
            this.latchService.getCharacteristic(Characteristic.LockTargetState).updateValue(Characteristic.LockTargetState.UNSECURED)

            setTimeout(() => {
              this.latchService.setCharacteristic(Characteristic.LockTargetState, Characteristic.LockTargetState.SECURED)
            }, 3000)
          }
        })
        break

      default:
        this.latchService.getCharacteristic(Characteristic.LockTargetState).updateValue(state)
    }

    callback(null)
  }

  updateSmartLockState (data) {
    const state = data.lastKnownState ? data.lastKnownState : data
    this.log.debug('updateSmartLockState:', state)

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

      case LOCK_STATE_JAMMED:
        this.lockService.getCharacteristic(Characteristic.LockTargetState).updateValue(Characteristic.LockTargetState.JAMMED)
        this.lockService.getCharacteristic(Characteristic.LockCurrentState).updateValue(Characteristic.LockCurrentState.JAMMED)
        this.latchService.getCharacteristic(Characteristic.LockTargetState).updateValue(Characteristic.LockTargetState.JAMMED)
        this.latchService.getCharacteristic(Characteristic.LockCurrentState).updateValue(Characteristic.LockCurrentState.JAMMED)

      default:
        this.log.warn('Unhandled door state:', state)
        this.currentState = Characteristic.LockCurrentState.UNKNOWN
    }

    if (state.doorsensorState === DOOR_STATE_DOOR_CLOSED) {
      this.contactSensorService.getCharacteristic(Characteristic.ContactSensorState).updateValue(Characteristic.ContactSensorState.CONTACT_DETECTED)
    } else if (state.doorsensorState === DOOR_STATE_DOOR_OPENED) {
      this.contactSensorService.getCharacteristic(Characteristic.ContactSensorState).updateValue(Characteristic.ContactSensorState.CONTACT_NOT_DETECTED)
    }

    if (state.batteryCritical) {
      this.batteryService.getCharacteristic(Characteristic.StatusLowBattery).updateValue(Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW)
    } else {
      this.batteryService.getCharacteristic(Characteristic.StatusLowBattery).updateValue(Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL)
    }

    if (state.batteryCharging) {
      this.batteryService.getCharacteristic(Characteristic.ChargingState).updateValue(Characteristic.ChargingState.CHARGING)
    } else {
      this.batteryService.getCharacteristic(Characteristic.ChargingState).updateValue(Characteristic.ChargingState.NOT_CHARGING)
    }

    this.batteryService.getCharacteristic(Characteristic.BatteryLevel).updateValue(state.batteryChargeState)
  }
}
