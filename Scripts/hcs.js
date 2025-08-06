var gedi = ee.ImageCollection("LARSE/GEDI/GEDI04_A_002_MONTHLY");
var embedding = ee.ImageCollection("GOOGLE/SATELLITE_EMBEDDING/V1/ANNUAL");
var years = ee.List.sequence(2019, 2024);

// var aoi = ee.FeatureCollection("FAO/GAUL_SIMPLIFIED_500m/2015/level2")
// .filter(ee.Filter.eq('ADM0_NAME', 'Malaysia'))
// .filter(ee.Filter.eq('ADM1_NAME', 'Sabah'))
// .union()

// Map.setOptions('SATELLITE')
// // Map.centerObject(aoi, 7)
// Map.addLayer(aoi, {}, 'Sabah', 0)


var agbCalculator = function (year){
  
  var startDate = ee.Date.fromYMD(year, 1, 1)
  var endDate = startDate.advance(1, 'year')

  var qualitymask = function (image){
    var mask1 = image.select('l4_quality_flag').eq(1)
    var mask2 = image.select('degrade_flag').eq(0)
    
    return image.updateMask(mask1).updateMask(mask2)
  };
  
  var errorMask = function (image){
    var mask = (image.select('agbd_se').divide(image.select('agbd'))).lte(0.5)
  
    return image.updateMask(mask)
  };
  
  var targetProj = ee.Projection('EPSG:4326').atScale(30);
  
  var gediFiltered = gedi.filter(ee.Filter.date(startDate,endDate))
  .filterBounds(aoi)
  .select('agbd')
  .mosaic()
  .clip(aoi)
  .reproject(targetProj)
  
  var embeddingsFiltered = embedding.filter(ee.Filter.date(startDate, endDate))
  .filterBounds(aoi)
  .mosaic()
  .clip(aoi)
  .reproject(targetProj)

  
  var stacked = gediFiltered.addBands(embeddingsFiltered)
  
  var classMask = stacked.select('agbd').mask().toInt().rename('class')
  
  var stacked = stacked.addBands(classMask)
  
  var samples = stacked.stratifiedSample({
    numPoints : 1000,
    classBand : 'class',
    region : aoi,
    scale : 10,
    projection : stacked.select('agbd').projection(),
    classValues : [0, 1],
    classPoints : [0, 1000],
    dropNulls : true,
    tileScale : 16
  })
  
  var predictors = embeddingsFiltered.bandNames()
  var dependent = stacked.bandNames().get(0)
  
  var model = ee.Classifier.smileRandomForest(50).setOutputMode('REGRESSION').train({
    features : samples,
    inputProperties : predictors,
    classProperty : dependent
  })
  
  var predicted = samples.classify({
    classifier : model,
    outputName : 'agbdPredicted'
  })
  
  var y = ee.Array(predicted.aggregate_array('agbd'))
  var y_cap = ee.Array(predicted.aggregate_array('agbdPredicted'))
  
  var rmse = (y.subtract(y_cap)).pow(2).reduce('mean', [0]).sqrt().get([0])
  
  
  var outputBandName = 'agbd_' + year
  
  var agbImage = embeddingsFiltered.classify({
    classifier : model,
    outputName : outputBandName
  })
  return {agb : agbImage, 
  rmse : rmse, 
  predicted : predicted}
};


var landCover = ee.ImageCollection("ESA/WorldCover/v100")
  .first()
  .clip(aoi);

var lcFilter = function (image) {
  var image = image.select('Map');
  var lcMask = image.eq(10)
    .or(image.eq(20))
    .or(image.eq(30))
    .or(image.eq(60))
    .or(image.eq(95));

  return image.updateMask(lcMask);
};

var lcFiltered = lcFilter(landCover);
Map.centerObject(aoi, 12)
Map.setOptions('SATELLITE');
Map.addLayer(lcFiltered, {}, 'Filtered Land Cover');

var gedi2 = gedi.filterDate('2021', '2022')
.filterBounds(aoi)
.mosaic()
.clip(aoi)
Map.addLayer(gedi2, {}, 'GEDI footprints')

var embeddings2 = embedding.filterDate('2021', '2022')
.filterBounds(aoi)
.mosaic()
.clip(aoi)
Map.addLayer(embeddings2, {
  bands : ['A01', 'A51', 'A25']
}, 'Embedding image')

var output = agbCalculator(2021)

var agbAOI = output.agb
var rmse = output.rmse
var prediction_feature = output.predicted

print('RMSE (Mg/ha)', rmse)

var chart = ui.Chart.feature.byFeature({
  features : prediction_feature,
  xProperty : 'agbd',
  yProperties : ['agbdPredicted']
}).setChartType('ScatterChart').setOptions({
  title : 'Aboveground Biomass (Mg/ha)',
  dataOpacity: 0.8,
  hAxis: {'title': 'Actual'},
  vAxis: {'title': 'Predicted'},
  legend: {position: 'right'},
  series: {
      0: {
        visibleInLegend: false,
        color: '#3CCFC1',
        pointSize: 3,
        pointShape: 'circle',
      },
    },
    trendlines: {
      0: {
        type: 'linear',
        color: '#F22811',
        lineWidth: 1,
        pointSize: 0,
        labelInLegend: 'Linear Fit',
        visibleInLegend: true,
        showR2: true
      }
    },
    chartArea: {left: 100, bottom: 100, width: '50%'},
});

print(chart)

var gediVis = {
  min: 8,
  max: 228,
  palette: ['#edf8fb', '#118C2E', '#D6AD58', '#FAF152', '#006d2c']
};

Map.addLayer(agbAOI.updateMask(lcFiltered), gediVis, 'Predicted AGB')

var carbon = agbAOI.updateMask(lcFiltered).divide(0.47)

var dummyImage = ee.Image(1).clip(carbon.geometry())

var HCS = dummyImage.where(carbon.gte(100), 5)  // High Density Forest
      .where(carbon.gte(60).and(carbon.lt(100)), 4)  // Medium Density Forest
      .where(carbon.gte(35).and(carbon.lt(60)), 3)  // Low Density Forest
      .where(carbon.gte(20).and(carbon.lt(35)), 2)  // Young Regrowth / Scrub
      .where(carbon.gt(0).and(carbon.lt(20)), 1)   // Very Low Biomass
      .where(carbon.lte(0), 0);                    // No Biomass / Cleared

Map.addLayer(HCS.updateMask(lcFiltered), {min: 0, max: 5, palette: ['gray', 'yellow', 'orange', 'lightgreen', 'green', 'darkgreen']}, 'HCS Classes');

// Define the legend title and palette
var legendTitle = 'High Carbon Stock (HCS) Classes';
var palette = ['gray', 'yellow', 'orange', 'lightgreen', 'green', 'darkgreen'];
var names = [
  'Open land',
  'Scrubs',
  'Young Regenerating forest',
  'Low Density Forest',
  'Medium Density Forest',
  'High Density Forest'
];

// Create the panel
var legend = ui.Panel({
  style: {
    position: 'top-right',
    padding: '8px 15px'
  }
});

// Add title
legend.add(ui.Label({
  value: legendTitle,
  style: { fontWeight: 'bold', fontSize: '14px', margin: '0 0 6px 0' }
}));

var titleBar = ui.Panel({
  style: {
    position: 'top-center',
    padding: '8px 15px'
  }
});

// Add title
titleBar.add(ui.Label({
  value: 'High Carbon Stock approach',
  style: { fontWeight: 'bold', fontSize: '20px', margin: '0 0 6px 0' }
}));


// Add color boxes with labels
for (var i = 0; i < names.length; i++) {
  var colorBox = ui.Label('', {
    backgroundColor: palette[i],
    padding: '8px',
    margin: '0 0 4px 0'
  });

  var description = ui.Label(names[i], {margin: '0 0 4px 6px'});
  var row = ui.Panel([colorBox, description], ui.Panel.Layout.Flow('horizontal'));
  legend.add(row);
}

// Add legend to the map
Map.add(legend);
Map.add(titleBar)






