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
'use strict';
const ip = require('ip');
const cp = require('child_process');
const execAsync = require('util').promisify(cp.exec)

const log = require('./logger.js')(__filename);

var running = false;
var workqueue = [];

exports.allow = function (rule, callback) {
    rule.target = 'ACCEPT';
    if (!rule.action) rule.action = '-A';
    newRule(rule, callback);
}

exports.drop = function (rule, callback) {
    rule.target = 'DROP';
    if (!rule.action) rule.action = '-A';
    newRule(rule, callback);
}

exports.reject = function (rule, callback) {
    rule.target = 'REJECT';
    if (!rule.action) rule.action = '-A';
    newRule(rule, callback);
}

exports.newRule = newRule;
exports.deleteRule = deleteRule;

function iptables(rule, callback) {
  log.debug("IP6TABLE: rule:",rule);
  running = true;
  
  let cmd = 'ip6tables';
  let args = iptablesArgs(rule);

  if (rule.sudo) {
    args = ['sudo', 'ip6tables', '-w'].concat(args);
    cmd = args.join(" ")
  }

  if (rule.checkBeforeAction) {
    let checkRule = JSON.parse(JSON.stringify(rule))
    checkRule.action = '-C'
    let checkArgs = iptablesArgs(checkRule)
    let checkCmd = ['sudo', 'ip6tables', '-w'].concat(checkArgs).join(" ")
    
    switch(rule.action) {
    case "-A":
      // check if exits before insertion
      cmd = `${checkCmd} || ${cmd}`
      break
    case "-D":
      cmd = `(${checkCmd} && ${cmd}); true`
      break
    default:
      break
    }    
  }
  
  log.debug("IPTABLE6:", cmd, workqueue.length);

  // for testing purpose only
  if(exports.test && typeof exports.test === 'function') {
    exports.test(cmd, args.join(" "))
    if (callback) {
      callback(null, null);
    }
    running = false;
    newRule(null, null);
    return
  }
  
  cp.exec(cmd, (err, stdout, stderr) => {
    if (err) {
      log.error("Failed to execute cmd ", cmd, err);
    }
    if (stdout) {
      log.info("stdout captured for:", cmd, "\n", stdout)
    }
    if (stderr) {
      log.info("stderr captured for:", cmd, "\n", stderr)
    }

    callback(err, stdout)
    running = false
    newRule(null, null);
  })
}

function iptablesArgs(rule) {
  var args = [];

  if (!rule.chain) rule.chain = 'INPUT';
  if(rule.table) args = args.concat(["-t", rule.table])
  if (rule.chain) args = args.concat([rule.action, rule.chain]);
  if (rule.protocol) args = args.concat(["-p", rule.protocol]);
  if (rule.src) args = args.concat(["--source", rule.src]);
  if (rule.dst) args = args.concat(["--destination", rule.dst]);
  if (rule.extra) args = args.concat([rule.extra]);
  if (rule.sport) args = args.concat(["--sport", rule.sport]);
  if (rule.dport) args = args.concat(["--dport", rule.dport]);
  if (rule.in) args = args.concat(["-i", rule.in]);
  if (rule.out) args = args.concat(["-o", rule.out]);
  if (rule.target) args = args.concat(["-j", rule.target]);
  if (rule.list) args = args.concat(["-n", "-v"]);
  if (rule.mac) args = args.concat(["-m","mac","--mac-source",rule.mac]);
  if(rule.todest) args = args.concat(["--to-destination", rule.todest])

  return args;
}

function newRule(rule, callback) {
    // always make a copy
    if (rule) {
        rule = JSON.parse(JSON.stringify(rule));
        rule.callback = callback;
    }
    if (running == true) {
      if (rule) {
            workqueue.push(rule);
        }
        return;
    } else {
        if (rule) {
            workqueue.push(rule);
        }
        let nextRule = workqueue.splice(0, 1);
        if (nextRule && nextRule.length > 0) {
            iptables(nextRule[0], nextRule[0].callback);
        }
    }
}


function deleteRule(rule, callback) {
    rule.action = '-D';
    iptables(rule, callback);
}

function flush() {
  return execAsync(
    "sudo ip6tables -w -F && sudo ip6tables -w -F -t nat && sudo ip6tables -w -F -t raw && sudo ip6tables -w -F -t mangle",
  ).catch(err => {
    log.error("IP6TABLE:FLUSH:Unable to flush", err)
  });
}

function _getDNSRedirectChain(type) {
  type = type || "local";
  let chain = "PREROUTING_DNS_DEFAULT";
  switch (type) {
    case "local":
      chain = "PREROUTING_DNS_DEFAULT";
      break;
    case "vpn":
      chain = "PREROUTING_DNS_VPN";
      break;
    case "vpnClient":
      chain = "PREROUTING_DNS_VPN_CLIENT";
      break;
    default:
      chain = "PREROUTING_DNS_DEFAULT";
  }
  return chain;
}

async function dnsFlushAsync(type) {
  type = type || "local";
  const chain = _getDNSRedirectChain(type);
  let rule = {
    sudo: true,
    chain: chain,
    action: '-F',
    table: 'nat',
    checkBeforeAction: false
  };

  return new Promise((resolve, reject) => {
    newRule(rule, (err) => {
      if (err) {
        log.error("Failed to apply rule: ", rule);
        reject(err);  
      } else {
        resolve();
      }
    });
  });
}

// run() is deleted as same functionality is provided in Iptables.run() 

function dnsRedirectAsync(server, port, type) {
  return new Promise((resolve, reject) => {
    dnsRedirect(server, port, type, (err) => {
      if(err) {
        reject(err)
      } else {
        resolve()
      }
    })
  })
}

function dnsRedirect(server, port, type, cb) {
  type = type || "local";
  const chain = _getDNSRedirectChain(type);
  let rule = {
    sudo: true,
    chain: chain,
    action: '-A',
    table: 'nat',
    protocol: 'udp',
    extra: '-m set ! --match-set no_dns_caching_mac_set src',
    dport: '53',
    target: 'DNAT',
    todest: `[${server}]:${port}`,
    checkBeforeAction: true    
  }

  newRule(rule, (err) => {
    if(err) {
      log.error("Failed to apply rule:", rule);
      cb(err)
    } else {
      rule.protocol = 'tcp'
      newRule(rule, cb)
    }
  })
}

function dnsUnredirectAsync(server, port, type) {
  return new Promise((resolve, reject) => {
    dnsUnredirect(server, port, type, (err) => {
      if(err) {
        reject(err)
      } else {
        resolve()
      }
    })
  })
}

function dnsUnredirect(server, port, type, cb) {
  type = type || "local";
  const chain = _getDNSRedirectChain(type);
  let rule = {
    sudo: true,
    chain: chain,
    action: '-D',
    table: 'nat',
    protocol: 'udp',
    extra: '-m set ! --match-set no_dns_caching_mac_set src',
    dport: '53',
    target: 'DNAT',
    todest: `[${server}]:${port}`,
    checkBeforeAction: true
  }

  newRule(rule, (err) => {
    if(err) {
      log.error("Failed to apply rule:", rule);
      cb(err)
    } else {
      rule.protocol = 'tcp'
      newRule(rule, cb)
    }
  })
}

function switchMonitoringAsync(state) {
  return new Promise((resolve, reject) => {
    switchMonitoring(state, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    })
  });
}

function switchMonitoring(state, cb) {
  let action = "-D";
  if (state !== true)
    action = "-I";
  let rule = {
    sudo: true,
    chain: "FW_NAT_BYPASS",
    action: action,
    table: "nat",
    target: "ACCEPT",
    checkBeforeAction: true
  }

  newRule(rule, (err) => {
    if (err) {
      log.error("Failed to apply rule: ", rule);
      cb(err);
    } else {
      rule.chain = "FW_BYPASS";
      rule.table = "filter";
      newRule(rule, cb);
    }
  });
}

exports.dnsRedirectAsync = dnsRedirectAsync
exports.dnsUnredirectAsync = dnsUnredirectAsync
exports.switchMonitoringAsync = switchMonitoringAsync
exports.dnsFlushAsync = dnsFlushAsync
exports.flush = flush 
