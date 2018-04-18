const site = require('../../package.json').name
const version = require('../../package.json').version
const nodeVersion = Number(process.version.match(/^v(\d+\.\d+)/)[1])
const colors = require('colors') // eslint-disable-line
const bodyParser = require('body-parser')
const finalhandler = require('finalhandler')
const fs = require('fs')
const help = require('./help')
const http = require('http')
const https = require('https')
const path = require('path')
const Router = require('router')
const router = Router()
const dadiStatus = require('@dadi/status')
const domainManager = require('./models/domain-manager')
const workspace = require('./models/workspace')

// let's ensure there's at least a dev config file here
const devConfigPath = path.join(__dirname, '/../../config/config.development.json')

fs.stat(devConfigPath, (err, stats) => {
  if (err && err.code === 'ENOENT') {
    fs.writeFileSync(devConfigPath, fs.readFileSync(devConfigPath + '.sample'))
  }
})

const auth = require(path.join(__dirname, '/auth'))
const Controller = require(path.join(__dirname, '/controller'))
const configPath = path.resolve(path.join(__dirname, '/../../config'))
const config = require(configPath)

function createServer (listener) {
  var protocol = config.get('server.protocol')

  if (protocol === 'http') {
    return http.createServer(listener)
  } else if (protocol === 'https') {
    var readFileSyncSafe = (path) => {
      try {
        return fs.readFileSync(path)
      } catch (ex) {
        console.log(ex)
      }

      return null
    }

    var passphrase = config.get('server.sslPassphrase')
    var caPath = config.get('server.sslIntermediateCertificatePath')
    var caPaths = config.get('server.sslIntermediateCertificatePaths')
    var serverOptions = {
      key: readFileSyncSafe(config.get('server.sslPrivateKeyPath')),
      cert: readFileSyncSafe(config.get('server.sslCertificatePath'))
    }

    if (passphrase && passphrase.length >= 4) {
      serverOptions.passphrase = passphrase
    }

    if (caPaths && caPaths.length > 0) {
      serverOptions.ca = []
      caPaths.forEach((path) => {
        var data = readFileSyncSafe(path)
        data && serverOptions.ca.push(data)
      })
    } else if (caPath && caPath.length > 0) {
      serverOptions.ca = readFileSyncSafe(caPath)
    }

    // we need to catch any errors resulting from bad parameters
    // such as incorrect passphrase or no passphrase provided
    try {
      return https.createServer(serverOptions, listener)
    } catch (ex) {
      var exPrefix = 'error starting https server: '
      switch (ex.message) {
        case 'error:06065064:digital envelope routines:EVP_DecryptFinal_ex:bad decrypt':
          throw new Error(exPrefix + 'incorrect ssl passphrase')
        case 'error:0906A068:PEM routines:PEM_do_header:bad password read':
          throw new Error(exPrefix + 'required ssl passphrase not provided')
        default:
          throw new Error(exPrefix + ex.message)
      }
    }
  }
}

function onListening (server) {
  var env = config.get('env')
  var address = server.address()

  if (env !== 'test') {
    var startText = '\n  ----------------------------\n'
    startText += '  Started \'DADI CDN\'\n'
    startText += '  ----------------------------\n'
    startText += '  Server:      '.green + address.address + ':' + address.port + '\n'
    startText += '  Version:     '.green + version + '\n'
    startText += '  Node.JS:     '.green + nodeVersion + '\n'
    startText += '  Environment: '.green + env + '\n'
    startText += '  ----------------------------\n'

    startText += '\n\n  Copyright ' + String.fromCharCode(169) + ' 2015-' + new Date().getFullYear() + ' DADI+ Limited (https://dadi.tech)'.white + '\n'

    console.log(startText)
  }
}

function onRedirectListening (server) {
  var env = config.get('env')
  var address = server.address()

  if (env !== 'test') {
    var startText = '\n  ----------------------------\n'
    startText += '  Started HTTP -> HTTPS Redirect\n'
    startText += '  ----------------------------\n'
    startText += '  Server:      '.green + address.address + ':' + address.port + '\n'
    startText += '  ----------------------------\n'

    console.log(startText)
  }
}

function onStatusListening (server) {
  var env = config.get('env')
  var address = server.address()

  if (env !== 'test') {
    var startText = '\n  ----------------------------\n'
    startText += '  Started standalone status endpoint\n'
    startText += '  ----------------------------\n'
    startText += '  Server:      '.green + address.address + ':' + address.port + '\n'
    startText += '  ----------------------------\n'

    console.log(startText)
  }
}

var Server = function () {}

Server.prototype.start = function (done) {
  router.use((req, res, next) => {
    const FAVICON_REGEX = /\/(favicon|(apple-)?touch-icon(-i(phone|pad))?(-\d{2,}x\d{2,})?(-precomposed)?)\.(jpe?g|png|ico|gif)$/i

    if (FAVICON_REGEX.test(req.url)) {
      res.statusCode = 204
      res.end()
    } else {
      next()
    }
  })

  router.use(bodyParser.json({limit: '50mb'}))

  router.get('/', function (req, res, next) {
    res.end('Welcome to DADI CDN')
  })

  var statusHandler = function (req, res, next) {
    var method = req.method && req.method.toLowerCase()
    var authorization = req.headers.authorization

    if (method !== 'post' || config.get('status.enabled') === false) {
      return next()
    } else {
      var params = {
        site: site,
        package: '@dadi/cdn',
        version: version,
        healthCheck: {
          authorization: authorization,
          baseUrl: 'http://' + config.get('server.host') + ':' + config.get('server.port'),
          routes: config.get('status.routes')
        }
      }

      dadiStatus(params, function (err, data) {
        if (err) return next(err)

        var responseMessages = {
          Green: 'Service is responding within specified parameters',
          Amber: 'Service is responding, but outside of specified parameters'
        }

        data.status = {
          status: data.routes[0].status,
          healthStatus: data.routes[0].healthStatus,
          message: responseMessages[data.routes[0].healthStatus] || 'Service is not responding correctly'
        }

        var resBody = JSON.stringify(data, null, 2)

        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Content-Length', Buffer.byteLength(resBody))
        return res.end(resBody)
      })
    }
  }

  // ensure that middleware runs in the correct order,
  // especially when running an integrated status page
  if (config.get('status.standalone')) {
    var statusRouter = Router()
    config.get('status.requireAuthentication') && auth(statusRouter)
    statusRouter.use('/api/status', statusHandler)

    var statusApp = http.createServer(function (req, res) {
      res.setHeader('Server', config.get('server.name'))
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Cache-Control', 'no-cache')
      statusRouter(req, res, finalhandler(req, res))
    })

    var statusServer = this.statusServer = statusApp.listen(config.get('status.port'))
    statusServer.on('listening', function () { onStatusListening(this) })

    auth(router)
  } else {
    if (config.get('status.requireAuthentication')) {
      auth(router)
      router.use('/api/status', statusHandler)
    } else {
      router.use('/api/status', statusHandler)
      auth(router)
    }
  }

  this.controller = new Controller(router)

  var redirectInstance
  var redirectServer
  var redirectPort = config.get('server.redirectPort')
  if (redirectPort > 0) {
    redirectInstance = http.createServer((req, res) => {
      var port = config.get('server.port')
      var hostname = req.headers.host.split(':')[0]
      var location = 'https://' + hostname + ':' + port + req.url

      res.setHeader('Location', location)
      res.statusCode = 301
      res.end()
    })
    redirectServer = this.redirectServer = redirectInstance.listen(redirectPort)
    redirectServer.on('listening', function () { onRedirectListening(this) })
  }

  let app = createServer((req, res) => {
    if (config.get('multiDomain.enabled')) {
      let domain = req.headers.host.split(':')[0]

      if (!domainManager.getDomain(domain)) {
        return help.sendBackJSON(404, {
          result: 'Failed',
          message: `Domain not configured: ${domain}`
        }, res)
      }

      req.__domain = domain
    }

    res.setHeader('Server', config.get('server.name'))
    res.setHeader('Access-Control-Allow-Origin', '*')

    if (req.url === '/api/status') {
      res.setHeader('Cache-Control', 'no-cache')
    }

    router(req, res, finalhandler(req, res))
  })

  let server = this.server = app.listen(config.get('server.port'))
  server.on('listening', function () { onListening(this) })

  this.readyState = 1

  workspace.createDirectories()
  workspace.startWatchingFiles()

  if (typeof done === 'function') {
    done()
  }
}

// this is mostly needed for tests
Server.prototype.stop = function (done) {
  this.readyState = 3

  workspace.stopWatchingFiles()

  this.server.close(err => {
    // if statusServer is running in standalone, close that too
    if (this.statusServer) {
      this.statusServer.close(err => {
        this.readyState = 0

        done && done(err)
      })
    } else {
      this.readyState = 0

      done && done(err)
    }
  })
}

module.exports = new Server()
module.exports.Server = Server
