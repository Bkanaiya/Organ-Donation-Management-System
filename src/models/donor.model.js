const mongoose = require('mongoose');

const donorSchema = new mongoose.Schema({
    Name: {
        type: String,
        required: [true, 'username is required'],
        unique: true,
        trim: true
    },
    Age: {
        type: Number,
        required: [true, 'age is required']
    },
    Gender: {
        type: String,
        required: [true, 'enter the gender'],
        enum: ['male', 'female']
    },
    State: {
        type: String,
        required: [true, 'state is required'],
    },
    District: {
        type: String,
        required: [true, 'district is required'],
        trim: true
    },
    Organ_Donated:{
        type:String,
        required:[true,'organ is required'],
        trim:true
    }
},{timestamps:true}
);

module.exports = mongoose.model('Donor', donorSchema);