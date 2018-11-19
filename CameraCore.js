var storage = require('node-persist');
var uuid = require('./').uuid;
var Accessory = require('./').Accessory;
var Service = require('./').Service;
var Characteristic = require('./').Characteristic;
var Camera = require('./').Camera;

console.log("HAP-NodeJS starting...");

// Initialize our storage system
storage.initSync();

// Start by creating our Bridge which will host all loaded Accessories
var cameraAccessory = new Accessory('Camera', uuid.generate("Camera"));

var cameraSource = new Camera();

cameraAccessory.configureCameraSource(cameraSource);

cameraAccessory.on('identify', function(paired, callback) {
  console.log("Node Camera identify");
  callback(); // success
});

cameraAccessory
 .addService(Service.Doorbell, 'Doorbell')
 .getCharacteristic(Characteristic.ProgrammableSwitchEvent)
 .on('get', function(callback){
   callback(null, didBellRing);
 });

// Publish the camera on the local network.
cameraAccessory.publish({
  username: "EC:22:3D:D3:CE:CE",
  port: 51062,
  pincode: "031-45-154",
  category: Accessory.Categories.VIDEO_DOORBELL
}, true);

cameraAccessory.bellRang = () => {
  cameraAccessory
    .getService(Service.Doorbell)
    .setCharacteristic(Characteristic.ProgrammableSwitchEvent, true);
}

//setInterval(cameraAccessory.bellRang, 10000);

var signals = { 'SIGINT': 2, 'SIGTERM': 15 };
Object.keys(signals).forEach(function (signal) {
  process.on(signal, function () {
    cameraAccessory.unpublish();
    setTimeout(function (){
        process.exit(128 + signals[signal]);
    }, 1000)
  });
});

