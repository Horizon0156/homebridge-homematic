'use strict'

// const request = require('request')
const HomeMaticRPC = require('./HomeMaticRPC.js').HomeMaticRPC
const HomeMaticRPCTestDriver = require('./HomeMaticRPCTestDriver.js').HomeMaticRPCTestDriver
const HomeMaticServiceClassLoader = require('./HomeMaticServiceClassLoader.js').HomeMaticServiceClassLoader
const HomeMaticRegaRequest = require('./HomeMaticRegaRequest.js').HomeMaticRegaRequest
const HomeMaticRegaRequestTestDriver = require('./HomeMaticRegaRequestTestDriver.js').HomeMaticRegaRequestTestDriver
const HomeMaticCacheManager = require('./HomeMaticCacheManager.js').HomeMaticCacheManager

// const inherits = require('util').inherits
const path = require('path')
const fs = require('fs')
var uuid
// var localCache
let localPath
let Service, Characteristic
let _homebridge
var isInTest = typeof global.it === 'function'

module.exports = function (homebridge) {
  _homebridge = homebridge
  uuid = homebridge.hap.uuid
  Service = homebridge.hap.Service
  Characteristic = homebridge.hap.Characteristic
  homebridge.registerPlatform('homebridge-homematic', 'HomeMatic', HomeMaticPlatform)
}

function HomeMaticPlatform (log, config, api) {
  let that = this
  this.log = log
  this.uuid = uuid
  this.homebridge = _homebridge
  this.config = config
  this.localCache = path.join(_homebridge.user.storagePath(), 'ccu.json')
  this.localPath = _homebridge.user.storagePath()
  this.localHomematicConfig = path.join(this.localPath, 'homematic_config.json')
  this.ccuIP = config.ccu_ip
  this.ccuPort = config.ccu_port || 8181
  this.cache = new HomeMaticCacheManager(log)
  if (api) {
    this.api = api
    if (api.version < 2.1) {
      throw new Error('Unexpected API version.')
    }
  }

  if (isInTest) {

  } else {
    this.mergeConfig()
    this.migrateConfig()

    // Silence the hello stuff in tests
    this.log.info('Homematic Plugin Version ' + this.getVersion())
    this.log.info('Plugin by thkl  https://github.com/thkl')
    this.log.info('Homematic is a registered trademark of the EQ-3 AG')
    this.log.info('Please report any issues to https://github.com/thkl/homebridge-homematic/issues')
    this.log.info('running in production mode')
    this.log.info('will connect to your ccu at %s:%d', this.ccuIP, this.ccuPort)
    this.log.warn('IMPORTANT !! Starting this version, your homematic custom configuration is located in %s', this.localHomematicConfig)
  }

  const test = this.createRegaRequest('PONG')
  test.script('Write(\'PONG\')', data => {
    if (!isInTest) {
      that.log.info('if %s is PONG CCU is alive', data)
    } else {

    }
  })

  this.filter_device = config.filter_device
  this.filter_channel = config.filter_channel

  this.outlets = config.outlets
  this.iosworkaround = config.ios10
  this.doors = config.doors
  this.windows = config.windows
  this.valves = config.valves
  this.variables = config.variables
  this.specialdevices = config.special
  this.programs = config.programs
  this.subsection = config.subsection
  this.vuc = config.variable_update_trigger_channel

  if ((this.subsection === undefined) || (this.subsection === '')) {
    this.log.warn('Uuhhh. There is no value for the key subsection in config.json.')
    this.log.warn('There will be no devices fetched from your ccu.')
    this.log.warn('Please create a subsection and put in all the channels,')
    this.log.warn('you want to import into homekit. Then add the name of that')
    this.log.warn('section into your config.json as "subsection"="....".')
    return
  }

  this.sendQueue = []
  this.timer = 0

  this.foundAccessories = []
  this.eventAdresses = []
  this.adressesToQuery = []

  // only init stuff if there is no test running
  if (!isInTest) {
    let port = config.local_port
    if (port === undefined) {
      port = 9090
    }

    this.xmlrpc = new HomeMaticRPC(this.log, this.ccuIP, port, 0, this)
    this.xmlrpc.init()

    this.virtual_xmlrpc = new HomeMaticRPC(this.log, this.ccuIP, port + 3, 3, this)
    this.virtual_xmlrpc.init()

    if (config.enable_wired !== undefined) {
      this.xmlrpcwired = new HomeMaticRPC(this.log, this.ccuIP, port + 1, 1, this)
      this.xmlrpcwired.init()
    }

    if (config.enable_hmip !== undefined) {
      this.xmlrpchmip = new HomeMaticRPC(this.log, this.ccuIP, port + 2, 2, this)
      this.xmlrpchmip.init()
    }

    const that = this
    process.on('SIGINT', () => {
      if (that.xmlrpc.stopping) {
        return
      }
      that.xmlrpc.stopping = true
      that.xmlrpc.stop()
      if (that.xmlrpcwired !== undefined) {
        that.xmlrpcwired.stop()
      }
      if (that.xmlrpchmip !== undefined) {
        that.xmlrpchmip.stop()
      }

      if (that.virtual_xmlrpc !== undefined) {
        that.virtual_xmlrpc.stop()
      }

      setTimeout(process.exit(0), 2000)
    })

    process.on('SIGTERM', () => {
      if (that.xmlrpc.stopping) {
        return
      }
      that.xmlrpc.stopping = true
      that.xmlrpc.stop()
      if (that.xmlrpcwired !== undefined) {
        that.xmlrpcwired.stop()
      }
      if (that.xmlrpchmip !== undefined) {
        that.xmlrpchmip.stop()
      }
      setTimeout(process.exit(0), 2000)
    })
  } else {
    // init the testdriver rpcInit
    this.xmlrpc = new HomeMaticRPCTestDriver(this.log, '127.0.0.1', 0, 0, this)
    this.xmlrpc.init()
  } // End init rpc stuff
}

HomeMaticPlatform.prototype.mergeConfig = function (callback) {
  if (fs.existsSync(this.localHomematicConfig)) {
    let that = this
    let data = fs.readFileSync(this.localHomematicConfig).toString()
    let myConfig = JSON.parse(data)
    this.log.info('[Core] merging configurations')
    Object.keys(myConfig).forEach(key => {
      that.config[key] = myConfig[key]
    })
  }
}

HomeMaticPlatform.prototype.migrateConfig = function () {
  // Save my Config once to a separate file
  if (!fs.existsSync(this.localHomematicConfig)) {
    let that = this
    let keysNotToCopy = ['platform', 'name', 'ccu_ip', 'subsection']
    let myConfig = {}
    Object.keys(this.config).forEach(key => {
      if (keysNotToCopy.indexOf(key) === -1) {
        myConfig[key] = that.config[key]
      }
    })
    this.log.info('[Core] Migrate configuration once to %s ...', this.localHomematicConfig)
    fs.writeFileSync(this.localHomematicConfig, JSON.stringify(myConfig, null, 2))
  }
}

HomeMaticPlatform.prototype.accessories = function (callback) {
  let that = this
  this.foundAccessories = []

  if ((this.subsection === undefined) || (this.subsection === '')) {
    callback(this.foundAccessories)
    return
  }

  this.log.debug('[Core] Fetching Homematic devices...')
  const internalconfig = this.internalConfig()
  const serviceclassLoader = new HomeMaticServiceClassLoader(this.log)
  serviceclassLoader.localPath = localPath
  serviceclassLoader.init(this.config.services)

  var json
  if (isInTest) {
    try {
      json = JSON.parse(this.config.testdata)
    } catch (e) {
      json = {}
      this.log.error('[Core] Error (%s) while loading test data %s', e, this.config.testdata)
    }
    this.buildaccesories(json, callback, internalconfig, serviceclassLoader)
  } else {
    let script = 'string sDeviceId;string sChannelId;boolean df = true;Write(\'{"devices":[\');foreach(sDeviceId, root.Devices().EnumIDs()){object oDevice = dom.GetObject(sDeviceId);if(oDevice){var oInterface = dom.GetObject(oDevice.Interface());if(df) {df = false;} else { Write(\',\');}Write(\'{\');Write(\'"id": "\' # sDeviceId # \'",\');Write(\'"name": "\' # oDevice.Name() # \'",\');Write(\'"address": "\' # oDevice.Address() # \'",\');Write(\'"type": "\' # oDevice.HssType() # \'",\');Write(\'"channels": [\');boolean bcf = true;foreach(sChannelId, oDevice.Channels().EnumIDs()){object oChannel = dom.GetObject(sChannelId);if(bcf) {bcf = false;} else {Write(\',\');}Write(\'{\');Write(\'"cId": \' # sChannelId # \',\');Write(\'"name": "\' # oChannel.Name() # \'",\');if(oInterface){Write(\'"intf": "\' # oInterface.Name() # \'",\');Write(\'"address": "\' # oInterface.Name() #\'.\' # oChannel.Address() # \'",\');}Write(\'"type": "\' # oChannel.HssType() # \'",\');Write(\'"access": "\' # oChannel.UserAccessRights(iulOtherThanAdmin)# \'"\');Write(\'}\');}Write(\']}\');}}Write(\']\');'

    script += 'var s = dom.GetObject("'
    script += this.subsection
    script += '");string cid;boolean sdf = true;if (s) {Write(\',"subsection":[\');foreach(cid, s.EnumUsedIDs()){ '
    script += ' if(sdf) {sdf = false;}'
    script += ' else { Write(\',\');}Write(cid);}Write(\']\');}'

    script += 'Write(\'}\');'

    var regarequest = this.createRegaRequest()
    this.log.debug('[Core] Local cache is set to %s', this.localCache)
    regarequest.timeout = this.config.ccufetchtimeout || 120
    regarequest.script(script, data => {
      if (data !== undefined) {
        try {
          that.log.debug('[Core] CCU response on device query are %s bytes', data.length)
          // Read Json
          json = JSON.parse(data)
          if ((json !== undefined) && (json.devices !== undefined)) {
            // Seems to be valid json
            if (that.localCache !== undefined) {
              fs.writeFile(that.localCache, data, err => {
                if (err) {
                  that.log.warn('[Core] Cannot cache ccu data ', err)
                }
                that.log.info('[Core] will cache ccu response to %s', that.localCache)
              })
            } else {
              that.log.warn('[Core] Cannot cache ccu data local cache was not set')
            }
          }
        } catch (e) {
          that.log.warn('[Core] Unable to parse live ccu data. Will try cache if there is one. If you want to know what, start homebridge in debug mode -> DEBUG=* homebridge -D')
          that.log.debug('[Core] JSON Error %s for Data %s', e, data)
        }
      }

      // Check if we got valid json from ccu
      if ((json === undefined) && (that.localCache !== undefined)) {
        // Try to load Data
        that.log.info('[Core] ok local cache is set to %s', that.localCache)
        try {
          fs.accessSync(that.localCache, fs.F_OK)
          // Try to load Data
          data = fs.readFileSync(that.localCache).toString()
          if (data !== undefined) {
            try {
              json = JSON.parse(data)
              that.log.info('[Core] loaded ccu data from local cache ... WARNING: your mileage may vary')
            } catch (e) {
              that.log.warn('[Core] Unable to parse cached ccu data. giving up')
            }
          }
        } catch (e) {
          that.log.warn('[Core] Unable to load cached ccu data. giving up')
        }
      } // End json is not here but try local cache
      this.buildaccesories(json, callback, internalconfig, serviceclassLoader)
      this.checkUpdate()
    })
  }
}

HomeMaticPlatform.prototype.checkUpdate = function () {
  // Version Check and autoupdate
  let that = this
  this.fetch_npmVersion('homebridge-homematic', npmVersion => {
    npmVersion = npmVersion.replace('\n', '')
    that.log.info('[Core] NPM %s vs Local %s', npmVersion, that.getVersion())
    if (npmVersion > that.getVersion()) {
      const autoupdate = that.config.autoupdate
      const instpath = that.config.updatepath
      if (autoupdate) {
        let cmd
        if (autoupdate === 'global') {
          cmd = 'sudo npm -g update homebridge-homematic'
        }

        if ((autoupdate === 'local') && (instpath)) {
          cmd = 'cd ' + instpath + 'npm update homebridge-homematic'
        }

        if ((autoupdate === 'github') && (instpath)) {
          cmd = 'cd ' + instpath + 'git pull'
        }

        if (cmd) {
          const exec = require('child_process').exec
          that.log.info('[Core] There is a new version. Autoupdate is set to %s, so we are updating ourself now .. this may take some seconds.', autoupdate)
          exec(cmd, (error, stdout, stderr) => {
            if (!error) {
              that.log.warn('[Core] A new version was installed recently. Please restart the homebridge process to complete the update')
              that.log.warn('[Core] Message from updater %s', stdout)
            } else {
              that.log.error('[Core] Error while updating.')
            }
          })
        } else {
          that.log.error('[Core] Some autoupdate settings missed.')
        }
      } else {
        that.log.warn('[Core] There is a new Version available. Please update with sudo npm -g update homebridge-homematic')
      }
    }
  })
}

HomeMaticPlatform.prototype.buildaccesories = function (json, callback, internalconfig, channelLoader) {
  let that = this
  if ((json !== undefined) && (json.devices !== undefined)) {
    json.devices.map(device => {
      const cfg = that.deviceInfo(internalconfig, device.type)

      let isFiltered = false

      if ((that.filter_device !== undefined) && (that.filter_device.indexOf(device.address) > -1)) {
        isFiltered = true
      } else {
        isFiltered = false
      }

      if ((device.channels !== undefined) && (!isFiltered)) {
        device.channels.map(ch => {
          let isChannelFiltered = false
          // var isSubsectionSelected = false
          // If we have a subsection list check if the channel is here
          if (json.subsection !== undefined) {
            const cin = (json.subsection.indexOf(ch.cId) > -1)
            // If not .. set filter flag
            isChannelFiltered = !cin
            // isSubsectionSelected = cin
          }
          if ((cfg !== undefined) && (cfg.filter !== undefined) && (cfg.filter.indexOf(ch.type) > -1)) {
            isChannelFiltered = true
          }
          if ((that.filter_channel !== undefined) && (that.filter_channel.indexOf(ch.address) > -1)) {
            isChannelFiltered = true
          }
          // That.log('name', ch.name, ' -> address:', ch.address)
          if ((ch.address !== undefined) && (!isChannelFiltered)) {
            // Switch found
            // Check if marked as Outlet or Door
            let special
            if ((that.outlets !== undefined) && (that.outlets.indexOf(ch.address) > -1)) {
              special = 'OUTLET'
            }
            if ((that.doors !== undefined) && (that.doors.indexOf(ch.address) > -1)) {
              special = 'DOOR'
            }
            if ((that.windows !== undefined) && (that.windows.indexOf(ch.address) > -1)) {
              special = 'WINDOW'
            }

            if ((that.valves !== undefined) && (that.valves.indexOf(ch.address) > -1)) {
              special = 'VALVE'
            }
            // Check if VIRTUAL KEY is Set as Variable Trigger
            if ((that.vuc !== undefined) && (ch.type === 'VIRTUAL_KEY') && (ch.name === that.vuc)) {
              that.log.debug('Channel ' + that.vuc + ' added as Variable Update Trigger')
              ch.type = 'VARIABLE_UPDATE_TRIGGER'
              channelLoader.loadChannelService(that.foundAccessories, 'VARIABLE_UPDATE_TRIGGER', ch, that, that.variables, cfg, 255, Service, Characteristic)
            } else {
              channelLoader.loadChannelService(that.foundAccessories, device.type, ch, that, special, cfg, ch.access, Service, Characteristic)
            }
          } else {
            // Channel is in the filter
          }
        })
      } else {
        that.log.debug('[Core] %s has no channels or is filtered', device.name)
      }
    })
  } // End Mapping all JSON Data
  if (that.programs !== undefined) {
    var ch = {}
    var cfg = {}

    that.programs.map(program => {
      if (that.iosworkaround === undefined) {
        that.log.debug('[Core] Program ' + program + ' added as Program_Launcher')
        ch.type = 'PROGRAM_LAUNCHER'
        ch.address = program
        ch.name = program
        channelLoader.loadChannelService(that.foundAccessories, 'PROGRAM_LAUNCHER', ch, that, 'PROGRAM', cfg, 255, Service, Characteristic)
      } else {
        cfg = that.deviceInfo(internalconfig, '')
        that.log.debug('[Core] Program ' + program + ' added as SWITCH cause of IOS 10')
        ch.type = 'SWITCH'
        ch.address = program
        ch.name = program
        channelLoader.loadChannelService(that.foundAccessories, 'SWITCH', ch, that, 'PROGRAM', cfg, 255, Service, Characteristic)
      }
    })
  } // End Mapping Programs

  if (that.specialdevices !== undefined) {
    that.specialdevices.map(specialdevice => {
      let name = specialdevice.name
      let type = specialdevice.type
      if ((name !== undefined) && (type !== undefined)) {
        var ch = {}
        ch.type = type
        ch.address = ''
        ch.name = name
        channelLoader.loadChannelService(that.foundAccessories, ch.type, ch, that, '', specialdevice.parameter || {}, 255, Service, Characteristic)
      }
    })
  }

  // Add Optional Variables
  if (that.variables !== undefined) {
    that.variables.map(variable => {
      const ch = {}
      const cfg = {}
      ch.type = 'VARIABLE'
      ch.address = variable
      ch.name = variable
      ch.intf = 'Variable'
      channelLoader.loadChannelService(that.foundAccessories, 'VARIABLE', ch, that, 'VARIABLE', cfg, 255, Service, Characteristic)
    })
  } // End Variables

  // Check number of devices
  const noD = that.foundAccessories.length
  that.log.debug('Number of mapped devices : ' + noD)
  if (noD > 100) {
    that.log.warn('********************************************')
    that.log.warn('* You are using more than 100 HomeKit      *')
    that.log.warn('* devices behind a bridge. At this time    *')
    that.log.warn('* HomeKit only supports up to 100 devices. *')
    that.log.warn('* This may end up that iOS is not able to  *')
    that.log.warn('* connect to the bridge anymore.           *')
    that.log.warn('********************************************')
  } else

  if (noD > 90) {
    that.log.warn('You are using more than 90 HomeKit')
    that.log.warn('devices behind a bridge. At this time')
    that.log.warn('HomeKit only supports up to 100 devices.')
    that.log.warn('This is just a warning. Everything should')
    that.log.warn('work fine until you are below that 100.')
  }
  callback(that.foundAccessories)
}

HomeMaticPlatform.prototype.setValue_rf_rpc = function (channel, datapoint, value, callback) {
  this.xmlrpc.setValue(channel, datapoint, value, callback)
}

HomeMaticPlatform.prototype.setValue_hmip_rpc = function (channel, datapoint, value, callback) {
  this.xmlrpchmip.setValue(channel, datapoint, value, callback)
}

HomeMaticPlatform.prototype.setValue_wired_rpc = function (channel, datapoint, value, callback) {
  this.xmlrpcwired.setValue(channel, datapoint, value, callback)
}

HomeMaticPlatform.prototype.setValue_virtual_rpc = function (channel, datapoint, value, callback) {
  this.virtual_xmlrpc.setValue(channel, datapoint, value, callback)
}

HomeMaticPlatform.prototype.setValue_rega = function (interf, channel, datapoint, value, callback) {
  let rega = this.createRegaRequest()
  var adrchannel = channel
  // add the interface if not provided
  if (channel.indexOf(interf) === -1) {
    adrchannel = interf + '.' + channel
  }
  this.log.debug('[Core] rega.setvalue %s.%s %s', adrchannel, datapoint, value)
  rega.setValue(adrchannel, datapoint, value)
  if (callback !== undefined) {
    callback()
  }
}

HomeMaticPlatform.prototype.setValue = function (intf, channel, datapoint, value) {
  let that = this
  if (channel !== undefined) {
    if (intf !== undefined) {
      let rpc = false

      if (intf.toLowerCase() === 'bidcos-rf') {
        rpc = true
        this.log.debug('[Core] routing via rf xmlrpc')
        this.setValue_rf_rpc(channel, datapoint, value, function (error, result) {
          if ((error !== undefined) && (error !== null)) {
            // fall back to rega
            that.log.debug('[Core] fallback routing via rega due interface error %s', error)
            that.setValue_rega(intf, channel, datapoint, value)
          }
        })
        return
      }
      if (intf.toLowerCase() === 'bidcos-wired') {
        rpc = true
        if (this.xmlrpcwired !== undefined) {
          this.log.debug('[Core] routing via wired xmlrpc')

          this.setValue_wired_rpc(channel, datapoint, value, function (error, result) {
            if ((error !== undefined) && (error !== null)) {
              // fall back to rega
              that.log.debug('[Core] fallback routing via rega due interface error %s', error)
              that.setValue_rega(intf, channel, datapoint, value)
            }
          })
        } else {
          // Send over Rega
          this.log.debug('[Core] wired is not activ;routing via rega')
          this.setValue_rega(intf, channel, datapoint, value)
        }
        return
      }

      if (intf.toLowerCase() === 'virtualdevices') {
        rpc = true
        if (this.setValue_virtual_rpc !== undefined) {
          this.log.debug('[Core] routing via wired virtual_rpc')

          this.setValue_virtual_rpc(channel, datapoint, value, function (error, result) {
            if ((error !== undefined) && (error !== null)) {
              // fall back to rega
              that.log.debug('[Core] fallback routing via rega due interface error %s', error)
              that.setValue_rega(intf, channel, datapoint, value)
            }
          })
        } else {
          // Send over Rega
          this.log.debug('[Core] virtual_rpc is not activ;routing via rega')
          this.setValue_rega(intf, channel, datapoint, value)
        }
        return
      }

      if (intf.toLowerCase() === 'hmip-rf') {
        rpc = true
        if (this.xmlrpchmip !== undefined) {
          this.log.debug('[Core] routing via ip xmlrpc')

          this.setValue_hmip_rpc(channel, datapoint, value, function (error, result) {
            if ((error !== undefined) && (error !== null)) {
              // fall back to rega
              that.log.debug('[Core] fallback routing via rega due interface error %s', error)
              that.setValue_rega(intf, channel, datapoint, value)
            }
          })
        } else {
          // Send over Rega
          this.log.debug('[Core] HmIP-RF not enabled, routing via rega')
          this.setValue_rega(intf, channel, datapoint, value)
        }
        return
      }

      if (intf === 'Variable') {
        let rega = this.createRegaRequest()
        rega.setVariable(channel, value)
        rpc = true
        return
      }

      // Rega Fallback
      if (rpc === false) {
        this.log.debug('[Core] routing via fallback rega')
        this.setValue_rega(intf, channel, datapoint, value)
      }
    } else {
      // Undefined Interface -> Rega should know how to deal with it
      this.log.debug('[Core] unknow interface ; routing via rega')
      this.setValue_rega(intf, channel, datapoint, value)
    }
  }
}

// this is just for simplifiyng the test cases ...
HomeMaticPlatform.prototype.createRegaRequest = function (testreturn) {
  var rega
  if (isInTest) {
    rega = new HomeMaticRegaRequestTestDriver(this.log, this.ccuIP, this.ccuPort)
    rega.platform = this
  } else {
    rega = new HomeMaticRegaRequest(this.log, this.ccuIP, this.ccuPort)
  }
  return rega
}

HomeMaticPlatform.prototype.remoteSetValue = function (channel, datapoint, value) {
  this.foundAccessories.map(accessory => {
    if ((accessory.adress === channel) || ((accessory.cadress !== undefined) && (accessory.cadress === channel))) {
      accessory.event(channel, datapoint, value)
    }
  })
}

HomeMaticPlatform.prototype.setRegaValue = function (channel, datapoint, value) {
  const rega = this.createRegaRequest()
  rega.setValue(channel, datapoint, value)
}

HomeMaticPlatform.prototype.sendRegaCommand = function (command, callback) {
  const rega = this.createRegaRequest()
  rega.script(command, data => {
    if (callback !== undefined) {
      callback(data)
    }
  })
}

HomeMaticPlatform.prototype.getValue_rega = function (interf, channel, datapoint, callback) {
  let that = this

  var adrchannel = channel
  // add the interface if not provided
  if (channel.indexOf(interf) === -1) {
    adrchannel = interf + '.' + channel
  }
  this.log.debug('[Core] check cache %s.%s', adrchannel, datapoint)
  let cValue = this.cache.getValue(adrchannel + '.' + datapoint)
  if (cValue) {
    if (callback) {
      callback(cValue)
    }
  } else {
    this.log.debug('[Core] cache failed for  %s.%s will transfer request to rega', adrchannel, datapoint)
    let rega = this.createRegaRequest()
    rega.getValue(adrchannel, datapoint, function (result) {
      that.log.debug('[Core] rega result for %s.%s is %s', adrchannel, datapoint, result)
      that.cache.doCache(adrchannel + '.' + datapoint, result)
      if (callback) {
        callback(result)
      }
    })
  }
}

HomeMaticPlatform.prototype.getValue = function (intf, channel, datapoint, callback) {
  if (channel !== undefined) {
    if (intf !== undefined) {
      let rpc = false
      this.log.debug('[Core] getValue (%s) %s.%s', intf, channel, datapoint)

      if (intf === 'Variable') {
        var rega = this.createRegaRequest()
        rega.getVariable(channel, callback)
        rpc = true
        return
      }

      // Fallback to Rega
      if (rpc === false) {
        this.getValue_rega(intf, channel, datapoint, callback)
      }
    } else {
      // Undefined Interface -> Rega should know how to deal with it
      this.getValue_rega(intf, channel, datapoint, callback)
    }
  } else {
    this.log.warn('[Core] unknow channel skipping ...')
    if (callback) {
      callback(undefined)
    }
  }
}

HomeMaticPlatform.prototype.prepareRequest = function (accessory, script) {
  const that = this
  this.sendQueue.push(script)
  that.delayed(100)
}

HomeMaticPlatform.prototype.sendPreparedRequests = function () {
  let script = 'var d'
  this.sendQueue.map(command => {
    script += command
  })
  this.sendQueue = []
  const regarequest = this.createRegaRequest()
  regarequest.script(script, data => {})
}

HomeMaticPlatform.prototype.sendRequest = function (accessory, script, callback) {
  const regarequest = this.createRegaRequest()
  regarequest.script(script, data => {
    if (data !== undefined) {
      try {
        const json = JSON.parse(data)
        callback(json)
      } catch (err) {
        callback(undefined)
      }
    }
  })
}

HomeMaticPlatform.prototype.delayed = function (delay) {
  const timer = this.delayed[delay]
  if (timer) {
    this.log('[Core] removing old command')
    clearTimeout(timer)
  }

  const that = this
  this.delayed[delay] = setTimeout(() => {
    clearTimeout(that.delayed[delay])
    that.sendPreparedRequests()
  }, delay || 100)
  this.log('[Core] New Timer was set')
}

HomeMaticPlatform.prototype.deviceInfo = function (config, devicetype) {
  let cfg
  if (config !== undefined) {
    const di = config.deviceinfo
    di.map(device => {
      if (device.type === devicetype) {
        cfg = device
      }
    })
  }

  return cfg
}

HomeMaticPlatform.prototype.registerAdressForEventProcessingAtAccessory = function (address, accessory, aFunction) {
  if (address !== undefined) {
    this.log.debug('[Core] adding new address %s for processing events at %s', address, accessory.name)
    if (aFunction !== undefined) {
      this.eventAdresses.push({
        address: address,
        accessory: accessory,
        function: aFunction
      })
    } else {
      this.eventAdresses.push({
        address: address,
        accessory: accessory
      })
    }
  } else {
    this.log.warn('[Core] Address not given %s,%s,%s', address, accessory.name, aFunction)
  }
}

HomeMaticPlatform.prototype.internalConfig = function () {
  try {
    const configPath = path.join(__dirname, './internalconfig.json')
    const config = JSON.parse(fs.readFileSync(configPath))
    return config
  } catch (err) {
    throw err
  }
}

HomeMaticPlatform.prototype.getVersion = function () {
  const pjPath = path.join(__dirname, './package.json')
  const pj = JSON.parse(fs.readFileSync(pjPath))
  return pj.version
}

HomeMaticPlatform.prototype.fetch_npmVersion = function (pck, callback) {
  let that = this
  const exec = require('child_process').exec
  const cmd = 'npm view ' + pck + ' version'
  exec(cmd, (error, stdout, stderr) => {
    if (error === null) {
      let npmVersion = stdout
      npmVersion = npmVersion.replace('\n', '')
      callback(npmVersion)
    } else {
      this.log.error('Unable to fetch new versions')
      let result = that.getVersion()
      callback(result)
    }
  })
}
