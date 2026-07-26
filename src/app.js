const express = require('express');
const mongoose = require('mongoose');
const Donor = require('./models/donor.model');
const Receiver = require('./models/receiver.model')

const app = express();
app.use(express.json());

const districtsByState = {
    'Andhra Pradesh': ['Visakhapatnam', 'Vijayawada', 'Guntur', 'Kurnool', 'Nellore'],
    'Arunachal Pradesh': ['Itanagar', 'Naharlagun', 'Tawang', 'Pasighat', 'Bomdila'],
    'Assam': ['Guwahati', 'Jorhat', 'Silchar', 'Dibrugarh', 'Tezpur'],
    'Bihar': ['Patna', 'Gaya', 'Muzaffarpur', 'Bhagalpur', 'Purnia'],
    'Chhattisgarh': ['Raipur', 'Bhilai', 'Bilaspur', 'Jagdalpur', 'Korba'],
    'Goa': ['Panaji', 'Margao', 'Vasco da Gama', 'Mapusa', 'Ponda'],
    'Gujarat': ['Ahmedabad', 'Surat', 'Vadodara', 'Rajkot', 'Jamnagar'],
    'Haryana': ['Gurugram', 'Faridabad', 'Hisar', 'Panipat', 'Rohtak'],
    'Himachal Pradesh': ['Shimla', 'Dharamshala', 'Mandi', 'Solan', 'Kullu'],
    'Jharkhand': ['Ranchi', 'Jamshedpur', 'Dhanbad', 'Bokaro', 'Hazaribagh'],
    'Karnataka': ['Bengaluru', 'Mysuru', 'Hubballi', 'Mangaluru', 'Belagavi'],
    'Kerala': ['Thiruvananthapuram', 'Kochi', 'Kozhikode', 'Thrissur', 'Kollam'],
    'Madhya Pradesh': ['Bhopal', 'Indore', 'Jabalpur', 'Gwalior', 'Ujjain'],
    'Maharashtra': ['Mumbai', 'Pune', 'Nagpur', 'Nashik', 'Aurangabad'],
    'Manipur': ['Imphal', 'Thoubal', 'Churachandpur', 'Kakching', 'Ukhrul'],
    'Meghalaya': ['Shillong', 'Tura', 'Nongpoh', 'Williamnagar', 'Jowai'],
    'Mizoram': ['Aizawl', 'Lunglei', 'Champhai', 'Serchhip', 'Kolasib'],
    'Nagaland': ['Kohima', 'Dimapur', 'Mokokchung', 'Tuensang', 'Wokha'],
    'Odisha': ['Bhubaneswar', 'Cuttack', 'Rourkela', 'Brahmapur', 'Sambalpur'],
    'Punjab': ['Chandigarh', 'Ludhiana', 'Amritsar', 'Jalandhar', 'Patiala'],
    'Rajasthan': ['Jaipur', 'Jodhpur', 'Udaipur', 'Kota', 'Ajmer'],
    'Sikkim': ['Gangtok', 'Namchi', 'Mangan', 'Gyalshing', 'Jorethang'],
    'Tamil Nadu': ['Chennai', 'Coimbatore', 'Madurai', 'Salem', 'Tiruchirappalli'],
    'Telangana': ['Hyderabad', 'Warangal', 'Nizamabad', 'Karimnagar', 'Khammam'],
    'Tripura': ['Agartala', 'Udaipur', 'Dharmanagar', 'Kailasahar', 'Belonia'],
    'Uttar Pradesh': ['Lucknow', 'Kanpur', 'Varanasi', 'Agra', 'Ghaziabad'],
    'Uttarakhand': ['Dehradun', 'Haridwar', 'Rishikesh', 'Haldwani', 'Nainital'],
    'West Bengal': ['Kolkata', 'Howrah', 'Durgapur', 'Asansol', 'Siliguri']
};

app.get('/', (req, res) => {
    res.send('Organ Donation API is running');
});

app.post('/api/districts', (req, res) => {
    const { state } = req.body;

    if (!state) {
        return res.status(400).json({ message: 'State is required' });
    }

    const districts = districtsByState[state.trim()];

    if (!districts) {
        return res.status(404).json({
            message: 'State not found. Please choose a state from India.'
        });
    }

    res.status(200).json({
        state: state.trim(),
        districts
    });
});


app.post('/api/receiver', async (req, res) => {
    try {
        const { Name, Age, Gender, State, District, Organ_needed } = req.body;

        if (!State || !District) {
            return res.status(400).json({ message: 'State and District are required' });
        }

        const districts = districtsByState[State.trim()];

        if (!districts) {
            return res.status(404).json({ message: 'State not found. Please choose a state from India.' });
        }

        if (!districts.includes(District.trim())) {
            return res.status(404).json({ message: 'District not found for this state' });
        }

        const receiver = await Receiver.create({
            Name,
            Age,
            Gender,
            State,
            District,
            Organ_needed
        });

        res.status(201).json({ message: 'receiver created successfully', receiver });
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
});

module.exports = app