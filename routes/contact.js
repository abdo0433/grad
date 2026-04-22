const express = require('express');
const router = express.Router();
const contact = require('../models/contact.us');


router.post('/contact-us',async(req,res)=>{
    try{

        const info=new contact({
            email:req.body.email,
            comment:req.body.comment,
        });
        const newcomment=await info.save();
        res.status(201).json({
        success: true,
        code: "201",
        message: 'Your message has been sent successfully'})

    }catch (error){
    res.status(400).json({
      success: false,
      code: "400",
      message: 'Something went wrong while sending your message',
      
    })
}


    
})

module.exports = router;