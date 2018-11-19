'use strict';

var debug = require('debug')('Camera');
var inherits = require('util').inherits;
var EventEmitter = require('events').EventEmitter;
var clone = require('./util/clone').clone;
var uuid = require('./util/uuid');
var Service = require('./Service').Service;
var Characteristic = require('./Characteristic').Characteristic;
var StreamController = require('./StreamController').StreamController;
var HomeKitTypes = require('./gen/HomeKitTypes');

var crypto = require('crypto');
var fs = require('fs');
var ip = require('ip');
var spawn = require('child_process').spawn;

module.exports = {
  Camera: Camera
};

function Camera() {
  this.services = [];
  this.streamControllers = [];

  this.pendingSessions = {};
  this.ongoingSessions = {};

  let options = {
    proxy: false, // Requires RTP/RTCP MUX Proxy
    disable_audio_proxy: false, // If proxy = true, you can opt out audio proxy via this
    srtp: true, // Supports SRTP AES_CM_128_HMAC_SHA1_80 encryption
    video: {
      resolutions: [
        // [1920, 1080, 30], // Width, Height, framerate
        //[1280, 960, 30],
        [1280, 720, 30],
        [1024, 768, 30],
        [640, 480, 30],
        [640, 360, 30],
        [480, 360, 30],
        [480, 270, 30],
        [320, 240, 30],
        [320, 240, 15], // Apple Watch requires this configuration
        [320, 180, 30]
      ],
      codec: {
        profiles: [0, 1, 2], // Enum, please refer StreamController.VideoCodecParamProfileIDTypes
        levels: [0, 1, 2] // Enum, please refer StreamController.VideoCodecParamLevelTypes
      }
    },
    audio: {
      comfort_noise: false,
      codecs: [
        {
          type: "OPUS", // Audio Codec
          samplerate: 24 // 8, 16, 24 KHz
        },
        {
          type: "AAC-eld",
          samplerate: 16
        }
      ]
    }
  }

  this.createCameraControlService();
  this._createStreamControllers(2, options); 
}

Camera.prototype.handleSnapshotRequest = function(request, callback) {
  let ffmpegCommand = `\
-f video4linux2 -input_format mjpeg -video_size ${request.width}x${request.height} -i /dev/video0 \
-vframes 1 -f mjpeg -`
  console.log(ffmpegCommand)
  let ffmpeg = spawn('ffmpeg', ffmpegCommand.split(' '), {env: process.env})
  var imageBuffer = Buffer.alloc(0)
  ffmpeg.stdout.on('data', function (data) { imageBuffer = Buffer.concat([imageBuffer, data]) })
  ffmpeg.stderr.on('data', function (data) { console.log('ffmpeg', String(data)) })
  ffmpeg.on('close', function (code) { callback(null, imageBuffer) })
}

Camera.prototype.handleCloseConnection = function(connectionID) {
  this.streamControllers.forEach(function(controller) {
    controller.handleCloseConnection(connectionID);
  });
}

Camera.prototype.prepareStream = function(request, callback) {
  // Invoked when iOS device requires stream

  var sessionInfo = {};

  let sessionID = request["sessionID"];
  let targetAddress = request["targetAddress"];

  sessionInfo["address"] = targetAddress;

  var response = {};

  let videoInfo = request["video"];
  if (videoInfo) {
    let targetPort = videoInfo["port"];
    let srtp_key = videoInfo["srtp_key"];
    let srtp_salt = videoInfo["srtp_salt"];

    // SSRC is a 32 bit integer that is unique per stream
    let ssrcSource = crypto.randomBytes(4);
    ssrcSource[0] = 0;
    let ssrc = ssrcSource.readInt32BE(0, true);

    let videoResp = {
      port: targetPort,
      ssrc: ssrc,
      srtp_key: srtp_key,
      srtp_salt: srtp_salt
    };

    response["video"] = videoResp;

    sessionInfo["video_port"] = targetPort;
    sessionInfo["video_srtp"] = Buffer.concat([srtp_key, srtp_salt]);
    sessionInfo["video_ssrc"] = ssrc; 
  }

  let audioInfo = request["audio"];
  if (audioInfo) {
    let targetPort = audioInfo["port"];
    let srtp_key = audioInfo["srtp_key"];
    let srtp_salt = audioInfo["srtp_salt"];

    // SSRC is a 32 bit integer that is unique per stream
    let ssrcSource = crypto.randomBytes(4);
    ssrcSource[0] = 0;
    let ssrc = ssrcSource.readInt32BE(0, true);

    let audioResp = {
      port: targetPort,
      ssrc: ssrc,
      srtp_key: srtp_key,
      srtp_salt: srtp_salt
    };

    response["audio"] = audioResp;

    sessionInfo["audio_port"] = targetPort;
    sessionInfo["audio_srtp"] = Buffer.concat([srtp_key, srtp_salt]);
    sessionInfo["audio_ssrc"] = ssrc;
  }

  let currentAddress = ip.address();
  var addressResp = {
    address: currentAddress
  };

  if (ip.isV4Format(currentAddress)) {
    addressResp["type"] = "v4";
  } else {
    addressResp["type"] = "v6";
  }

  response["address"] = addressResp;
  this.pendingSessions[uuid.unparse(sessionID)] = sessionInfo;

  callback(response);
}

Camera.prototype.handleStreamRequest = function(request) {
  // Invoked when iOS device asks stream to start/stop/reconfigure
  var sessionID = request["sessionID"];
  var requestType = request["type"];
  if (sessionID) {
    let sessionIdentifier = uuid.unparse(sessionID);

    if (requestType == "start") {
      var sessionInfo = this.pendingSessions[sessionIdentifier];
      if (sessionInfo) {
        var width = 1280;
        var height = 720;
        var fps = 30;
        var bitrate = 300;

        let videoInfo = request["video"];
        if (videoInfo) {
          width = videoInfo["width"];
          height = videoInfo["height"];

          let expectedFPS = videoInfo["fps"];
          if (expectedFPS < fps) {
            fps = expectedFPS;
          }

          bitrate = videoInfo["max_bit_rate"];
        }

        let address = sessionInfo["address"];
        let port = sessionInfo["video_port"];
        let srtp = sessionInfo["video_srtp"].toString('base64');
        let ssrc = sessionInfo["video_ssrc"];

        let ffmpegCommand = `-f video4linux2 -input_format h264 -video_size ${width}x${height} -framerate ${fps} -i /dev/video0 -vcodec copy -an -payload_type 99 -ssrc ${ssrc} -f rtp -srtp_out_suite AES_CM_128_HMAC_SHA1_80 -srtp_out_params ${srtp} srtp://${address}:${port}?rtcpport=${port}&localrtcpport=${port}&pkt_size=1378`
        console.log(ffmpegCommand);
        let ffmpeg = spawn('ffmpeg', ffmpegCommand.split(' '), {env: process.env});
        ffmpeg.stderr.on('data', function (data) { console.log('ffmpeg', String(data)) })
        this.ongoingSessions[sessionIdentifier] = ffmpeg;
      }

      delete this.pendingSessions[sessionIdentifier];
    } else if (requestType == "stop") {
      var ffmpegProcess = this.ongoingSessions[sessionIdentifier];
      if (ffmpegProcess) {
        ffmpegProcess.kill('SIGKILL');
      }

      delete this.ongoingSessions[sessionIdentifier];
    }
  }
}

Camera.prototype.createCameraControlService = function() {
  var controlService = new Service.CameraControl();

  // Developer can add control characteristics like rotation, night vision at here.

  this.services.push(controlService);
}

// Private

Camera.prototype._createStreamControllers = function(maxStreams, options) {
  let self = this;

  for (var i = 0; i < maxStreams; i++) {
    var streamController = new StreamController(i, options, self);

    self.services.push(streamController.service);
    self.streamControllers.push(streamController);
  }
}
