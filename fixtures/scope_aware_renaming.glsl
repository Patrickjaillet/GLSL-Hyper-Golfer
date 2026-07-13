float helperOne(float longParamName)
{
    float localVarOne = longParamName * 2.0;
    return localVarOne;
}

float helperTwo(float anotherParam)
{
    float localVarTwo = anotherParam + 1.0;
    return localVarTwo;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    fragColor = vec4(helperOne(1.0) + helperTwo(2.0), 0.0, 0.0, 1.0);
}
