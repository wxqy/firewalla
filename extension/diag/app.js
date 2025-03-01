/*    Copyright 2016 Firewalla LLC
 *
 *    This program is free software: you can redistribute it and/or  modify
 *    it under the terms of the GNU Affero General Public License, version 3,
 *    as published by the Free Software Foundation.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    GNU Affero General Public License for more details.
 *
 *    You should have received a copy of the GNU Affero General Public License
 *    along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

'use strict'

const log = require("../../net2/logger")('diag');

const express = require('express');
const path = require('path');

const port = 8835

const Promise = require('bluebird')

const exec = require('child-process-promise').exec
const fs = require('fs')
Promise.promisifyAll(fs)

const jsonfile = require('jsonfile');
const writeFileAsync = Promise.promisify(jsonfile.writeFile);

const { wrapIptables } = require('../../net2/Iptables.js')

const sem = require('../../sensor/SensorEventManager.js').getInstance();

const VIEW_PATH = 'view';
const STATIC_PATH = 'static';

const errorCodes = {
  "firekick": 101,
  "firemain": 102,
  "fireapi": 103,
  "firemon": 104,
  "memory": 201,
  "database": 301,
  "databaseConnectivity": 302,
  "gid": 401,
  "ip": 501
}

class App {
  constructor() {
    this.app = express();

    this.app.engine('mustache', require('mustache-express')());
    this.app.set('view engine', 'mustache');

    this.app.set('views', path.join(__dirname, VIEW_PATH));
    //this.app.disable('view cache'); //for debug only

    this.routes();
  }

  getSystemTime() {
    return new Date() / 1000
  }

  async getSystemServices() {
    const fireKickCmd = "systemctl is-active firekick"
    const fireMainCmd = "systemctl is-active firemain"
    const fireApiCmd = "systemctl is-active fireapi"
    const fireMonCmd = "systemctl is-active firemon"

    try {
      await exec(fireKickCmd)
    } catch (err) {
      log.error("firekick is not alive", err);
      return errorCodes.firekick
    }

    try {
      await exec(fireMainCmd)
    } catch (err) {
      log.error("firemain is not alive", err);
      return errorCodes.firemain
    }

    try {
      await exec(fireApiCmd)
    } catch (err) {
      log.error("fireapi is not alive", err);
      return errorCodes.fireapi
    }

    try {
      await exec(fireMonCmd)
    } catch (err) {
      log.error("firemon is not alive", err);
      return errorCodes.firemon
    }

    return 0
  }

  getCloudConnectivity() {
    return this.connected
  }

  async getSystemMemory() {
    const result = await exec("free -m")
    const stdout = result.stdout
    const lines = stdout.split(/\n/g)

    for (var i = 0; i < lines.length; i++) {
      lines[i] = lines[i].split(/\s+/)
    }

    const allMem = parseInt(lines[1][1])

    if (allMem > 490) {
      return 0
    } else {
      return errorCodes.memory
    }
  }

  getNodeVersion() {
    return process.version
  }

  getUptime() {
    return require('os').uptime()
  }

  async getDatabase() {
    try {
      await exec("systemctl is-active redis-server")
    } catch (err) {
      log.error("Failed to check database", err);
      return errorCodes.database
    }

    return 0
  }

  async getDatabaseConnectivity() {
    try {
      await exec("redis-cli get mode")
    } catch (err) {
      log.error("Failed to check database connection status", err);
      return errorCodes.databaseConnectivity
    }
    return 0
  }

  async getGID() {
    try {
      const gid = await exec("redis-cli hget sys:ept gid")
      return gid && gid.stdout && gid.stdout.substring(0, 8)
    } catch (err) {
      log.error("Failed to get gid", err);
      return null
    }
  }

  async getFullGID() {
    try {
      const gid = await exec("redis-cli hget sys:ept gid")
      return gid && gid.stdout && gid.stdout.replace("\n", "")
    } catch (err) {
      log.error("Failed to get gid", err);
      return null
    }
  }

  async getPrimaryIP() {
    const eth0s = require('os').networkInterfaces()["eth0"]

    if (eth0s) {
      for (let index = 0; index < eth0s.length; index++) {
        const eth0 = eth0s[index]
        if (eth0.family == "IPv4") {
          return eth0.address
        }
      }
    }

    return ''
  }

  async getQRImage() {
    if (!this.broadcastInfo) {
      return null;
    }

    try {
      const imagePath = `${__dirname}/static/firewalla_pairing_info.png`;
      const jsonPath = "/tmp/pairing.info.json";

      const pairingInfo = JSON.parse(JSON.stringify(this.broadcastInfo));
      pairingInfo.type = "pairing";
      delete pairingInfo.keyhint;
      delete pairingInfo.service;
      delete pairingInfo.mid;
      delete pairingInfo.verifymode;

      await writeFileAsync(jsonPath, pairingInfo);

      const cmd = `cat ${jsonPath} | qrencode -o ${imagePath}`;

      await exec(cmd);
      return imagePath;
    } catch (err) {
      log.error("Failed to get QRImage", err);
      return null
    }
  }

  routes() {
    this.router = express.Router();

    this.app.use('/' + VIEW_PATH, this.router);
    this.app.use('/' + STATIC_PATH, express.static(path.join(__dirname, STATIC_PATH)));

    this.app.use('/log', (req, res) => {
      const filename = "/home/pi/logs/FireKick.log";
      (async () => {
        const gid = await this.getFullGID()
        await fs.accessAsync(filename, fs.constants.F_OK)
        //tail -n 1000 /home/pi/logs/FireKick.log | sed -r   "s/0-9]{1,2}(;[0-9]{1,2})?)?[mGK]//g"
        const result = (await exec(`tail -n 1000 ${filename}`)).stdout
        let lines = result.split("\n")
        lines = lines.map((originLine) => {
          let line = originLine
          line = line.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '')
          line = line.replace(new RegExp(gid, "g"), "<****gid****>")
          line = line.replace(/type in this key:.*$/g, "type in this key: <****key****>")
          line = line.replace(/Inviting .{10,40} to group/g, "Inviting <****rid****> to group")
          line = line.replace(/Set SYS:EPT.*/, "Set SYS:EPT<****token****>")
          return line
        })

        res.setHeader('content-type', 'text/plain');
        res.end(lines.join("\n"))
      })().catch((err) => {
        log.error("Failed to fetch log", err);
        res.status(404).send('')
      })
    });

    this.app.use('/pairing', (req, res) => {
      if (this.broadcastInfo) {
        res.json(this.broadcastInfo);
      } else {
        res.status(501).send('');
      }
    });

    this.app.use('/pair/ping', (req, res) => {
      res.json({});
    });

    this.app.use('/pair/ready', async (req, res) => {
      try {
        const values = await this.getPairingStatus();
        if(values.success) {
          res.json({
            ready: true
          });
        } else {
          res.json({
            ready: false,
            content: values
          });
        }
      } catch(err) {
        log.error("Failed to process request", err);
        res.json({
          ready: false
        });
      }
    });

    this.app.use('*', async (req, res) => {
      log.info("Got a request in *")

      try {
        const values = await this.getPairingStatus();
        if(values.error) {
          log.error("Failed to process request", err);
          res.status(500).send({})
        } else {
          res.render('welcome', values)
        }
      } catch(err) {
        log.error("Failed to process request", err);
        res.status(500).send({})
      }
    })
  }

  async getPairingStatus() {
    try {
      const time = this.getSystemTime()
      const ip = await this.getPrimaryIP();
      const gid = await this.getGID()
      const database = await this.getDatabase()
      const uptime = this.getUptime()
      const nodeVersion = this.getNodeVersion()
      const memory = await this.getSystemMemory()
      const connected = this.getCloudConnectivity()
      const systemServices = await this.getSystemServices()
      const expireDate = this.expireDate;
      const qrImagePath = await this.getQRImage()

      let success = true
      let values = {
        now: new Date() / 1000
      }

      if(!this.broadcastInfo) {
        values.err_binding = true
        success = false;
      }

      if(qrImagePath) {
        values.qrImage = true;
      } else {
        success = false;
      }

      if(ip == "") {
        values.err_ip = true
        success = false
      } else {
        values.ip = ip
      }

      if(gid == null) {
        values.err_config = true
        success = false
      }

      if(database != 0) {
        values.err_database = true
        success = false
      }

      if(memory != 0) {
        values.err_memory = true
        success = false
      }

      if(connected != true) {
        values.err_cloud = true
        success = false
      }

      if(systemServices != 0) {
        values.err_service = true
        success = false
      }

      values.success = success

      return values;

    } catch(err) {
      log.error("Failed to get pairing status, err:", err);
      return {
        success: false,
        error: true
      }
    }
  }

  async iptablesRedirection(create = true) {
    const findInf = await exec(`ip addr show dev eth0 | awk '/inet / {print $2}'|cut -f1 -d/`);
    const ips = findInf.stdout.split('\n')

    const action = create ? '-A' : '-D';

    for (const ip of ips) {
      if (!ip) continue;

      log.info(create ? 'creating' : 'removing', `port forwording from 80 to ${port} on ${ip}`);
      const cmd = wrapIptables(`sudo iptables -w -t nat ${action} PREROUTING -p tcp --destination ${ip} --destination-port 80 -j REDIRECT --to-ports ${port}`);
      await exec(cmd);
    }
  }

  start() {
    this.app.listen(port, () => {
      log.info(`Httpd listening on port ${port}!`)

      sem.on("DiagRedirectionRenew", (event) => {
        log.info("Renew port redirection")
        this.iptablesRedirection();
      })

    });
  }
}

module.exports = App
