/* jslint node: true */

'use strict';

const { COMMANDS } = require('./constants');

const net = require('net');
const Parser = require('expr-eval').Parser;
const { DATAFIELDS } = require('./constants');


class Scheduler {
    constructor(config, adapter) {
        this.address = config.ws_address;
        this.port = config.ws_port;
        this.interval = config.ws_freq;
        this.adapter = adapter;

        this.activeCalls = [];

        // select activated calls
        for (const cmd of COMMANDS) {
            if (cmd.configurable) {
                const cfg = cmd.config_variable;

                if (config[cfg] == true) {
                    adapter.log.info('Scheduler call ' + cmd.config_variable + ' activated');
                    this.activeCalls.push(cmd);
                }
            }

        }


        this.fwClient = new net.Socket();
        // firmware 
        this.fwClient.on('data', this.parse_response.bind(this));
        this.fwClient.on('close', this.fwClient_close.bind(this));
        this.fwClient.on('error', this.server_error.bind(this));

        this.schedule_timer = null;
        this.run = 0;

        this.adapter.log.debug(`Weatherstation IP: ${this.address}`);
        this.adapter.log.debug(`Weatherstation port: ${this.port}`);
        this.adapter.log.debug(`Scheduler Interval: ${this.interval}`);
    }

    start() {
        if (this.interval > 0) {
            this.schedule_timer = setInterval(this.getUpdateFromWS.bind(this), this.interval * 1000);
        } else {
            this.adapter.log.console.error('Configuration error, interval cannot be 0');

        }
    }

    stop() {
        if (this.schedule_timer)
            clearInterval(this.schedule_timer);
        this.fwClient.destroy();
    }


    getUpdateFromWS() {
        this.adapter.log.info('Scheduler pulling for new data');

        this.run = 0;

        this.fwClient.connect(this.port, this.address, this.client_connect.bind(this));
    }

    server_error(e) {
        this.adapter.log.error(`Connection error on ${this.address || '0.0.0.0'}:${this.port}: ${e}`);
    }


    client_connect() {
        const current_call = this.activeCalls[this.run];

        this.adapter.log.debug('Scheduler connected to weather station run ' + current_call.command);
        this.fwClient.write(new Uint8Array(current_call.command));
    }


    parse_response(data) {
        this.adapter.log.debug('FW Scheduler Received data string: ' + data.toString('hex'));

        const buf = Buffer.from(data.toString('hex'), 'hex');
        let objData = COMMANDS[0].parser.parse(buf);

        this.adapter.log.debug('Data Command received: ' + objData.command + ' subcommand ' + objData.subcommand);
        let dataparser, channel;


        for (const cmd of this.activeCalls) {
            if (parseInt(cmd.command_int) == parseInt(objData.command) &&
                parseInt(cmd.subcommand_int) == parseInt(objData.subcommand)) {
                dataparser = cmd.parser;
                channel = cmd.channel;
                break;
            }
        }

        if (dataparser) {
            if (dataparser != "dontParse") {
                objData = dataparser.parse(buf);
                this.adapter.log.debug('Data object: ' + JSON.stringify(objData));
                this.updateIODataStore(channel, objData);
            }
            else {
                this.adapter.log.debug("Scheduler received data that will not be parsed");
            }
        } else {
            this.adapter.log.error('Scheduler received data for unkown command ' + objData.command + ' subcommand ' + objData.subcommand);

        }

        this.run++;

        if (this.run < this.activeCalls.length) {
            this.client_connect();
        } else {
            this.fwClient.destroy();
        }

    }

    updateIODataStore(channel, json_data) {
        this.adapter.log.info('Scheduler updating IOBroker states');

        const myobj = {};
        const parser = new Parser();

        
        for (const attr in DATAFIELDS) {
            // check if this has a mapping to the a data point
            const c_id = channel + '.' + DATAFIELDS[attr].id;

            if (DATAFIELDS[attr].scheduler != null && json_data[DATAFIELDS[attr].scheduler]) {
                myobj[c_id] = json_data[DATAFIELDS[attr].scheduler];
                
                if (DATAFIELDS[attr].scheduler_conversion != null) {
                    const exp = parser.parse(DATAFIELDS[attr].scheduler_conversion);
                    myobj[c_id] = exp.evaluate({ x: myobj[c_id] });
                } 
            }
        }

        this.adapter.setStates(new Date(), myobj);

    }


    fwClient_close() {
        this.adapter.log.debug('FW Scheduler Connection closed');
    }


}

module.exports = Scheduler;
